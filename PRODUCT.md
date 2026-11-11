# Produto

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Desenvolvedores individuais que gerenciam projetos Docker Compose em seus dispositivos.

## Product Purpose

O Docker Sandbox Manager reúne em um aplicativo desktop a descoberta, o monitoramento e as ações sobre projetos Docker Compose de um workspace. O sucesso é encontrar projetos e operar seus serviços em um só painel, sem precisar alternar entre terminais.

## Positioning

Um painel local que combina descoberta de projetos Compose em diretórios de trabalho com monitoramento e operações sobre serviços no contexto Docker escolhido.

## Operating Context

O usuário escolhe um contexto Docker e um workspace, varre diretórios para encontrar projetos Compose e acompanha ou opera projetos e serviços. O uso requer Docker acessível e o plugin Docker Compose v2 (`docker compose`). Dados e preferências do app são armazenados localmente no dispositivo.

## Capabilities and Constraints

- Acompanhar projetos, serviços, containers, portas e recursos; pesquisar, filtrar, favoritar e agrupar projetos.
- Iniciar, parar e reiniciar serviços; executar Pull, Build e Recriar; selecionar perfis Compose e arquivo `.env` por projeto.
- Consultar logs sob demanda, métricas e histórico local, diagnósticos, volumes e redes; usar shell `sh` em containers ativos.
- Os valores de arquivos de ambiente nunca são exibidos no app.
- A remoção de volumes e redes exige confirmação e só é permitida para recursos identificados como pertencentes ao projeto e sem containers associados.
- A memória agregada é uma soma aproximada dos valores informados pelo Docker. Portas são verificadas por TCP; essa verificação não cobre UDP.
- O terminal oferece entrada e saída de texto, sem pseudo-terminal.

## Brand Commitments

- Nome do produto: Docker Sandbox Manager.
- A interface e a documentação existentes usam português.

## Evidence on Hand

- Implementação e documentação existentes descrevem o produto e suas funções (`README.md`, `src/` e `src-tauri/`).
- O projeto inclui o ícone do produto em `src-tauri/icons/icon.png`.
- Não há depoimentos, estudos de caso ou benchmarks documentados; trabalhos futuros não devem inventá-los.

## Product Principles

- Reunir descoberta, monitoramento e ações Compose locais em um só lugar.
- Executar operações no contexto Docker escolhido pelo usuário.
- Manter dados e preferências do produto no dispositivo.
- Tornar explícitos os limites e efeitos das operações, protegendo dados e recursos do projeto.
