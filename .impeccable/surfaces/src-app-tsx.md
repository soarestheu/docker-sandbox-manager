---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/Dashboard.tsx"]
---

# Aplicativo Docker Sandbox Manager

## Escopo e modo

Telas Projetos e Dashboard do aplicativo desktop local. Modo Operate: encontrar projetos Compose, operar serviços e monitorar containers.

## Público e tarefa

Desenvolvedores individuais que gerenciam projetos Docker Compose em seus dispositivos. A tarefa é descobrir projetos no workspace, operar serviços e consultar telemetria sem alternar entre telas ou terminais.

## Ação e conteúdo

Selecionar um projeto abre seus serviços e detalhes num painel lateral direito. A tela Dashboard mostra métricas dos serviços selecionados, logs e terminais. A navegação flutuante alterna entre Projetos e Dashboard.

## Restrições

Preservar chamadas e comportamentos Tauri existentes, conteúdo em português, ações e estados reais do Docker. Manter React; não migrar para Svelte. Em desenvolvimento, não reabrir o app elevado nem interromper o servidor Vite.

## Direção e momento memorável

Deep Obsidian com superfícies escuras limpas, divisores discretos, contornos consistentes e profundidade radial sutil. O momento central é selecionar um projeto e ver seus serviços e controles aparecerem no painel lateral sem recarregar a tela.

## Decisões em aberto

Nenhuma decisão visual em aberto; as diretrizes visuais e a estrutura das telas foram especificadas pelo usuário.

## Direction contract

THESIS: Uma bancada local que conecta descoberta, operação e observabilidade Compose; recusa a tabela simples e mantém os serviços junto ao contexto do projeto.

OWN-WORLD: Deep Obsidian, fundo quase preto com gradientes radiais discretos, superfícies leves, divisores finos, raios consistentes, acentos semânticos contidos e navegação dock flutuante.

STORY: O desenvolvedor encontra um projeto, entende seu estado, seleciona um serviço e opera ou acompanha seus recursos no Dashboard; os comandos Tauri continuam nos mesmos controles.

FIRST VIEWPORT: No desktop, barra compacta no topo, resumo e filtros, lista de projetos à esquerda e detalhes/serviços à direita; dock compacto no centro inferior. No Dashboard, resumo, três métricas e serviços selecionados aparecem sem rolagem horizontal.

FORM: Direção e composição pinadas pelo usuário, sem torneio de conceitos; seed: none (pinned), “Adote um tema escuro profundo e minimalista (Deep Obsidian)” e “Reestruture a tela de projetos em um grid assimétrico moderno ou em uma visualização de ‘Painel Lateral de Detalhes’ (Split-Pane)”.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
