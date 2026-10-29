use serde::{ser::SerializeStruct, Serialize, Serializer};

/// The one error type that crosses IPC. The UI switches on `code`, shows `message`.
#[derive(Debug, thiserror::Error)]
pub enum KalypsoError {
    #[error("{0} not found")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0} already exists")]
    Conflict(String),
    #[error("{0} does not belong to namespace {1}")]
    WrongNamespace(String, String),
    #[error("vault: {0}")]
    Vault(String),
    #[error("container runtime: {0}")]
    Runtime(String),
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl KalypsoError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::Invalid(_) => "invalid",
            Self::Conflict(_) => "conflict",
            Self::WrongNamespace(..) => "wrong_namespace",
            Self::Vault(_) => "vault",
            Self::Runtime(_) => "runtime",
            Self::Db(_) => "database",
            Self::Io(_) => "io",
        }
    }
}

impl Serialize for KalypsoError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("KalypsoError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, KalypsoError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_message() {
        let json = serde_json::to_value(KalypsoError::WrongNamespace("secret s-1".into(), "work".into())).unwrap();
        assert_eq!(json["code"], "wrong_namespace");
        assert_eq!(json["message"], "secret s-1 does not belong to namespace work");
    }
}
