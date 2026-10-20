use workbench_core::{serve, Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "workbench_core=info".into()),
        )
        .init();

    let config = Config::from_env()?;
    let data_dir = config.data_dir.clone();
    let token_from_env = config.token.is_some();
    let server = serve(config).await?;
    println!("WORKBENCH_LISTENING=http://{}", server.addr);
    if !token_from_env {
        println!("WORKBENCH_TOKEN_FILE={}", data_dir.join("token").display());
    }
    tracing::info!("workbench-core listening on http://{}", server.addr);

    tokio::signal::ctrl_c().await?;
    server.shutdown().await;
    Ok(())
}
