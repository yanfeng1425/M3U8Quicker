use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    digest::{digest, Digest, SHA256},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex},
    time::{timeout, Instant},
};

use crate::{models::FileType, state::AppState};

const LISTEN_ON: &str = "127.0.0.1:47873";
const MAX_ROWS: usize = 500;
const MAX_BODY: usize = 2 * 1024 * 1024 + 12 + 16;
const MAX_PENDING: usize = 32;
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(35);
const RECEIPT: &[u8] = b"accepted";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BatchHandoffDraft {
    items: Vec<DraftItem>,
    extra_headers: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DraftItem {
    input: String,
    file_type: Option<FileType>,
}

struct PendingHandoff {
    key: LessSafeKey,
    expires: Instant,
    sender: Option<oneshot::Sender<BatchHandoffDraft>>,
    receipt: Option<(Digest, Vec<u8>)>,
}

#[derive(Default)]
pub struct BatchHandoff {
    started: Mutex<bool>,
    transfers: Mutex<Transfers>,
}

#[derive(Default)]
struct Transfers {
    pending: HashMap<String, PendingHandoff>,
    accepted: HashSet<String>,
}

impl BatchHandoff {
    fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/batch/v2/{id}", post(receive_batch))
            .layer(DefaultBodyLimit::max(MAX_BODY))
            .with_state(self.clone())
    }

    async fn listen(self: &Arc<Self>, address: &str) -> Result<(), &'static str> {
        let mut started = self.started.lock().await;
        if !*started {
            let listener = TcpListener::bind(address)
                .await
                .map_err(|_| "port_unavailable")?;
            let router = self.router();
            tauri::async_runtime::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });
            *started = true;
        }
        Ok(())
    }

    async fn register(
        &self,
        id: String,
        key: LessSafeKey,
    ) -> Result<oneshot::Receiver<BatchHandoffDraft>, &'static str> {
        let mut transfers = self.transfers.lock().await;
        let now = Instant::now();
        transfers.pending.retain(|_, entry| entry.expires > now);
        if transfers.pending.contains_key(&id) || transfers.accepted.contains(&id) {
            return Err("duplicate");
        }
        if transfers.pending.len() >= MAX_PENDING {
            return Err("busy");
        }
        let (sender, receiver) = oneshot::channel();
        transfers.pending.insert(
            id,
            PendingHandoff {
                key,
                expires: now + HANDOFF_TIMEOUT,
                sender: Some(sender),
                receipt: None,
            },
        );
        Ok(receiver)
    }
}

#[tauri::command]
pub async fn await_batch_handoff(
    state: tauri::State<'_, AppState>,
    id: String,
    key: String,
) -> Result<BatchHandoffDraft, &'static str> {
    if !is_id(&id) || key.len() != 64 {
        return Err("invalid_request");
    }
    let raw_key = hex::decode(key).map_err(|_| "invalid_request")?;
    let key = make_key(&raw_key)?;
    state.batch_handoff.listen(LISTEN_ON).await?;
    let receiver = state.batch_handoff.register(id, key).await?;
    let handoff = state.batch_handoff.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(HANDOFF_TIMEOUT).await;
        let now = Instant::now();
        handoff.transfers.lock().await.pending.retain(|_, entry| entry.expires > now);
    });
    timeout(HANDOFF_TIMEOUT, receiver)
        .await
        .map_err(|_| "timeout")?
        .map_err(|_| "timeout")
}

fn is_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn make_key(raw: &[u8]) -> Result<LessSafeKey, &'static str> {
    let key = UnboundKey::new(&AES_256_GCM, raw).map_err(|_| "invalid_request")?;
    Ok(LessSafeKey::new(key))
}

fn context(id: &str, kind: &str) -> String {
    format!("m3u8quicker-batch-v2:{id}:{kind}")
}

fn open_payload(key: &LessSafeKey, id: &str, body: &[u8]) -> Option<BatchHandoffDraft> {
    let nonce = Nonce::try_assume_unique_for_key(body.get(..12)?).ok()?;
    let mut ciphertext = body.get(12..)?.to_vec();
    let plaintext = key
        .open_in_place(nonce, Aad::from(context(id, "payload")), &mut ciphertext)
        .ok()?;
    let draft: BatchHandoffDraft = serde_json::from_slice(plaintext).ok()?;
    if draft.items.is_empty()
        || draft.items.len() > MAX_ROWS
        || draft
            .items
            .iter()
            .any(|item| item.input.trim().is_empty() || item.input.contains(['\r', '\n', '\0']))
    {
        return None;
    }
    Some(draft)
}

fn seal_receipt(key: &LessSafeKey, id: &str) -> Option<Vec<u8>> {
    let mut nonce = [0; 12];
    SystemRandom::new().fill(&mut nonce).ok()?;
    let mut ciphertext = RECEIPT.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(context(id, "receipt")),
        &mut ciphertext,
    )
    .ok()?;
    let mut packet = nonce.to_vec();
    packet.extend(ciphertext);
    Some(packet)
}

async fn receive_batch(
    Path(id): Path<String>,
    State(state): State<Arc<BatchHandoff>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_id(&id) || headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
        != Some("application/octet-stream")
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut transfers = state.transfers.lock().await;
    let Some(entry) = transfers.pending.get_mut(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if entry.expires <= Instant::now() {
        transfers.pending.remove(&id);
        return StatusCode::NOT_FOUND.into_response();
    }
    let body_digest = digest(&SHA256, &body);
    if let Some((previous, receipt)) = &entry.receipt {
        return if previous.as_ref() == body_digest.as_ref() {
            receipt.clone().into_response()
        } else {
            StatusCode::CONFLICT.into_response()
        };
    }
    let Some(draft) = open_payload(&entry.key, &id, &body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(receipt) = seal_receipt(&entry.key, &id) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Some(sender) = entry.sender.take() else {
        return StatusCode::CONFLICT.into_response();
    };
    if sender.send(draft).is_err() {
        return StatusCode::GONE.into_response();
    }
    entry.receipt = Some((body_digest, receipt.clone()));
    transfers.accepted.insert(id);
    receipt.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "01234567890123456789012345678901";
    const SECRET: [u8; 32] = [42; 32];

    fn packet(rows: usize, secret: &[u8]) -> Vec<u8> {
        let key = make_key(secret).unwrap();
        let mut nonce = [0; 12];
        SystemRandom::new().fill(&mut nonce).unwrap();
        let draft = BatchHandoffDraft {
            items: (0..rows)
                .map(|index| DraftItem {
                    input: format!("https://example.test/{index}.m3u8"),
                    file_type: Some(FileType::Hls),
                })
                .collect(),
            extra_headers: "referer:https://example.test/".to_string(),
        };
        let mut body = serde_json::to_vec(&draft).unwrap();
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(context(ID, "payload")),
            &mut body,
        )
        .unwrap();
        [nonce.as_slice(), &body].concat()
    }

    #[tokio::test]
    async fn local_handoff_retries_authenticates_and_delivers_100_items_once() {
        let handoff = Arc::new(BatchHandoff::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/batch/v2/{ID}", listener.local_addr().unwrap());
        let router = handoff.router();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let submit = |body: Vec<u8>| {
            client.post(&endpoint).header("Content-Type", "application/octet-stream").body(body)
        };

        let valid = packet(100, &SECRET);
        assert_eq!(submit(valid.clone()).send().await.unwrap().status(), StatusCode::NOT_FOUND);
        let receiver = handoff.register(ID.to_string(), make_key(&SECRET).unwrap()).await.unwrap();
        assert_eq!(submit(packet(100, &[7; 32])).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
        assert_eq!(submit(packet(MAX_ROWS + 1, &SECRET)).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
        assert_eq!(submit(vec![0; MAX_BODY + 1]).send().await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);

        let response = submit(valid.clone()).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.content_length(), Some(36));
        let receipt = response.bytes().await.unwrap();
        let mut plaintext = receipt[12..].to_vec();
        let key = make_key(&SECRET).unwrap();
        assert_eq!(
            key.open_in_place(
                Nonce::try_assume_unique_for_key(&receipt[..12]).unwrap(),
                Aad::from(context(ID, "receipt")),
                &mut plaintext,
            ).unwrap(),
            RECEIPT
        );
        let draft = receiver.await.unwrap();
        assert_eq!(draft.items.len(), 100);
        assert_eq!(draft.items[99].input, "https://example.test/99.m3u8");
        assert_eq!(submit(valid).send().await.unwrap().bytes().await.unwrap(), receipt);
        assert_eq!(submit(packet(100, &SECRET)).send().await.unwrap().status(), StatusCode::CONFLICT);

        handoff.transfers.lock().await.pending.get_mut(ID).unwrap().expires = Instant::now();
        assert_eq!(submit(packet(100, &SECRET)).send().await.unwrap().status(), StatusCode::NOT_FOUND);
        assert!(matches!(
            handoff.register(ID.to_string(), make_key(&SECRET).unwrap()).await,
            Err("duplicate"),
        ));
        server.abort();
    }

    #[tokio::test]
    async fn reports_a_conflicting_port_without_displacing_its_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let handoff = Arc::new(BatchHandoff::default());
        assert_eq!(handoff.listen(&address).await, Err("port_unavailable"));
        assert!(!*handoff.started.lock().await);
    }
}
