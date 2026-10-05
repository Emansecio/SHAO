# SHAO Backend

Backend/core local do SHAO. Use `./start.ps1` (PowerShell) ou `npm --prefix backend run start`. Node 26+ é necessário pela integração SQLite embutida (`node:sqlite`); nenhuma instalação de banco ou pacote de runtime é exigida. O armazenamento padrão fica em `data/shao.sqlite` (WAL), override por `SHAO_DATA_DIR`; loopback `127.0.0.1:4317`, override `SHAO_PORT`.

Leia `shared/README.md` para o contrato HTTP, SSE, eventos e adapters. O runtime oficial depende dos logins locais Claude Code/Codex CLI; SHAO não coleta credenciais ou API keys. Verifique estado no preflight (`GET /api/health`).

Desenvolvimento: `npm --prefix backend test` e `npm --prefix backend run check`. Para UI, compile `frontend` e o backend servirá `frontend/dist` same-origin; em Vite use proxy `/api` para `http://127.0.0.1:4317`.
