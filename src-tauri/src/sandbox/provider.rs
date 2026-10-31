//! What a sandbox backend must do. KALYPSO sits on top of existing tools
//! (Docker/Podman today; Microsandbox, E2B and Quicksand next), so everything
//! engine-specific lives behind this trait. Namespaces, the vault, policies,
//! budgets and IPC never talk to an engine directly.

use std::pin::Pin;

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde::Serialize;
use ts_rs::TS;

use super::{NewSandbox, SandboxStatusEvent};
use crate::error::Result;

/// A provider as the UI sees it: shown in the New sandbox form.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ProviderInfo {
    /// Stored on each sandbox (`runtime` column): "docker", "podman", "microsandbox"…
    pub kind: String,
    pub label: String,
    /// "container", "microvm" or "vm".
    pub isolation: String,
    pub network_modes: Vec<String>,
    pub resource_limits: bool,
    /// Runs somewhere else (hosted); costs and latency apply.
    pub remote: bool,
}

/// A running command's stdout and stdin, for byte streams such as port forwards.
pub struct ExecStream {
    pub output: BoxStream<'static, std::io::Result<Vec<u8>>>,
    pub input: Pin<Box<dyn tokio::io::AsyncWrite + Send>>,
}

/// A sandbox is identified by its namespace and KALYPSO id; each provider maps
/// that to its own handle (container name, VM id, remote sandbox id).
#[async_trait]
pub trait SandboxProvider: Send + Sync + 'static {
    fn info(&self) -> ProviderInfo;

    /// Whether this provider owns sandboxes recorded with `kind`.
    fn handles(&self, kind: &str) -> bool {
        self.info().kind == kind
    }

    /// For tests and engine-specific diagnostics only.
    fn as_any(&self) -> &dyn std::any::Any;

    /// Set up what isolates a namespace (e.g. its internal network). Idempotent.
    async fn prepare_namespace(&self, ns: &str) -> Result<()>;
    /// Undo `prepare_namespace`. Idempotent.
    async fn teardown_namespace(&self, ns: &str) -> Result<()>;

    /// Create the sandbox, stopped and hardened. Returns the provider's handle.
    async fn create(&self, ns: &str, id: &str, spec: &NewSandbox) -> Result<String>;
    async fn start(&self, ns: &str, id: &str) -> Result<()>;
    async fn resume(&self, ns: &str, id: &str) -> Result<()>;
    async fn pause(&self, ns: &str, id: &str) -> Result<()>;
    async fn stop(&self, ns: &str, id: &str) -> Result<()>;
    /// Delete the sandbox and its storage. Succeeds if it is already gone.
    async fn remove(&self, ns: &str, id: &str) -> Result<()>;
    /// "running", "paused" or "stopped".
    async fn status(&self, ns: &str, id: &str) -> Result<&'static str>;

    /// Run a command as root and collect its output, or start it in the background with `detach`.
    /// These are KALYPSO's own commands; agents choose their user through the supervisor.
    async fn exec(&self, ns: &str, id: &str, cmd: &[&str], detach: bool) -> Result<(i64, String)>;
    /// Run a command with `input` on stdin, so data never appears in its arguments.
    async fn exec_with_stdin(&self, ns: &str, id: &str, cmd: &[&str], input: &[u8]) -> Result<i64>;
    /// Run a command and hand back its stdin/stdout as a live byte stream.
    async fn open_stream(&self, ns: &str, id: &str, cmd: &[&str]) -> Result<ExecStream>;

    /// An interactive terminal running `cmd` with a TTY: stdin in, everything the
    /// terminal shows out. Returns the stream and a handle for [`Self::resize_tty`].
    async fn open_tty(&self, _ns: &str, _id: &str, _cmd: &[&str], _cwd: &str, _rows: u16, _cols: u16) -> Result<(ExecStream, String)> {
        Err(crate::error::KalypsoError::Runtime(format!("{} sandboxes don't support terminals yet", self.info().label)))
    }

    async fn resize_tty(&self, _handle: &str, _rows: u16, _cols: u16) -> Result<()> {
        Ok(())
    }

    /// The sandbox's address on its namespace network, if it has one.
    async fn address(&self, ns: &str, id: &str) -> Result<Option<String>>;

    /// Status changes for KALYPSO sandboxes, whoever caused them. Ends if the backend disconnects.
    fn watch(&self) -> Result<BoxStream<'static, SandboxStatusEvent>>;
}
