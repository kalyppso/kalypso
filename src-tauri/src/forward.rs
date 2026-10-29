//! Port forwarding into sandboxes, like `kubectl port-forward`.
//!
//! A namespace network is internal, so the engine can't publish ports from it.
//! Instead KALYPSO listens on 127.0.0.1 and pipes each connection into the
//! sandbox through an exec channel (`nc 127.0.0.1 <port>`). Nothing is exposed
//! beyond this machine and the sandbox's network mode is left untouched.

use std::collections::HashMap;
use std::sync::Mutex;

use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::Docker;
use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use ts_rs::TS;

use crate::error::{KalypsoError, Result};

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct PortForward {
    pub ns: String,
    pub sandbox: String,
    pub container_port: u16,
    pub host_port: u16,
}

struct Active {
    info: PortForward,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct Forwards {
    active: Mutex<HashMap<(String, u16), Active>>,
}

impl Forwards {
    /// Forward `container_port` of a running sandbox to a free port on 127.0.0.1.
    /// Opening the same port twice returns the existing forward.
    pub async fn open(&self, docker: Docker, container: String, ns: &str, sandbox: &str, container_port: u16) -> Result<PortForward> {
        if container_port == 0 {
            return Err(KalypsoError::Invalid("port must be between 1 and 65535".into()));
        }
        if let Some(a) = self.active.lock().unwrap().get(&(sandbox.to_string(), container_port)) {
            return Ok(a.info.clone());
        }
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let host_port = listener.local_addr()?.port();
        let info = PortForward { ns: ns.into(), sandbox: sandbox.into(), container_port, host_port };
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (docker, container) = (docker.clone(), container.clone());
                tokio::spawn(async move {
                    if let Err(e) = pipe(&docker, &container, container_port, stream).await {
                        tracing::debug!(error = %e, container_port, "forwarded connection ended with an error");
                    }
                });
            }
        });
        tracing::info!(sandbox, container_port, host_port, "port forward opened");
        self.active.lock().unwrap().insert((sandbox.to_string(), container_port), Active { info: info.clone(), task });
        Ok(info)
    }

    pub fn list(&self, ns: &str) -> Vec<PortForward> {
        let mut out: Vec<_> = self.active.lock().unwrap().values().filter(|a| a.info.ns == ns).map(|a| a.info.clone()).collect();
        out.sort_by_key(|f| (f.sandbox.clone(), f.container_port));
        out
    }

    pub fn close(&self, sandbox: &str, container_port: u16) -> bool {
        match self.active.lock().unwrap().remove(&(sandbox.to_string(), container_port)) {
            Some(a) => {
                a.task.abort();
                true
            }
            None => false,
        }
    }

    /// Close every forward of a sandbox (it stopped or was deleted).
    pub fn close_sandbox(&self, sandbox: &str) {
        self.active.lock().unwrap().retain(|(sb, _), a| {
            let keep = sb != sandbox;
            if !keep {
                a.task.abort();
            }
            keep
        });
    }
}

/// Copy bytes both ways between a local TCP connection and `nc` inside the sandbox.
async fn pipe(docker: &Docker, container: &str, port: u16, stream: TcpStream) -> Result<()> {
    let port = port.to_string();
    let exec = docker
        .create_exec(
            container,
            CreateExecOptions {
                cmd: Some(vec!["nc", "127.0.0.1", port.as_str()]),
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| KalypsoError::Runtime(e.to_string()))?;
    let StartExecResults::Attached { mut output, mut input } =
        docker.start_exec(&exec.id, None).await.map_err(|e| KalypsoError::Runtime(e.to_string()))?
    else {
        return Err(KalypsoError::Runtime("exec unexpectedly detached".into()));
    };
    let (mut tcp_read, mut tcp_write) = stream.into_split();

    let upstream = async {
        let mut buf = [0u8; 16 * 1024];
        loop {
            let n = tcp_read.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            input.write_all(&buf[..n]).await?;
        }
        input.shutdown().await
    };
    let downstream = async {
        while let Some(chunk) = output.next().await {
            if let Ok(LogOutput::StdOut { message }) = chunk {
                tcp_write.write_all(&message).await?;
            }
        }
        tcp_write.shutdown().await
    };
    // Either side closing ends the connection.
    tokio::select! {
        r = upstream => r?,
        r = downstream => r?,
    }
    Ok(())
}
