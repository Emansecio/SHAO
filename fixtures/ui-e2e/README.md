# Fixture ui-e2e (fictícia)

Workspace pequeno para validar a UI do SHAO contra o backend real. Código e dados são sintéticos;
a missão é só leitura local: nenhum scan, payload, rede ou alvo externo.

## Missão de teste sugerida (prompt)

> Revise `src/import-service.ts`: a importação em lote grava linha a linha dentro do loop.
> Publique evidência com trecho e linha, peça a um revisor para contestar o achado
> e responda entre pares antes de me resumir. Não altere arquivos.

## Critérios

1. Persistência por linha identificada com evidência (arquivo + linha).
2. Contraponto de um revisor respondido entre pares.
3. Recomendação de contrato (parcial vs atômico) registrada no relatório.
