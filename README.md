# Docker Sandbox Manager

Painel local para projetos Docker Compose, construído com Tauri, React e TypeScript.

Em telas maiores, a coluna esquerda reúne o dashboard (projetos, containers, serviços e portas) e a seleção de diretório; a coluna direita reúne os projetos e seus containers. Em telas menores, as colunas se empilham.

Use **Recolher** ou **Expandir** no cabeçalho de cada projeto para ocultar ou mostrar seus serviços, sem perder a seleção nem interromper o monitoramento de status. O status e as ações do projeto continuam visíveis. Concluir uma inicialização expande o projeto automaticamente, mas não abre logs.

## Serviços e portas

Selecione os serviços dentro de um projeto para **Iniciar selecionados** ou **Parar selecionados**. Cada serviço também possui uma ação individual, inclusive serviços sem portas ou ainda não iniciados. Quando há réplicas, a ação afeta todos os containers daquele serviço.

A inicialização da seleção usa `docker compose up -d --no-deps`: somente os serviços escolhidos são iniciados, sem iniciar suas dependências automaticamente. A parada da seleção usa `docker compose stop` e mantém os containers para iniciar novamente. As ações do projeto inteiro continuam usando `up -d` e `down` (sem remover volumes).

Os nomes dos serviços e as portas vêm de `docker compose config --format json` e `docker compose ps --all --format json`, sem inferir o serviço pelo número da porta. O estado é atualizado a cada três segundos, após a consulta anterior terminar, e ao concluir uma ação. Durante a execução, os controles ficam bloqueados para evitar operações concorrentes no mesmo projeto.

Os indicadores **Iniciando** e **Parando** aparecem somente nos serviços incluídos na ação. Os demais mantêm seus rótulos enquanto aguardam; ações no projeto inteiro indicam progresso em todos os seus serviços.

Portas TCP publicadas mostram **Disponível** ou **Indisponível** conforme a conexão ao endereço de publicação. Portas de serviços parados mostram **Serviço parado**. UDP não é testado com TCP. O estado de saúde do container é exibido separadamente. Falhas do Compose aparecem no projeto, sem serem tratadas como sucesso ou projeto parado.

Publicações equivalentes em `0.0.0.0` e `::` (IPv4/IPv6) aparecem em uma única tag, com ambos os endereços no tooltip. Portas, protocolos, destinos e endereços específicos diferentes continuam separados. O dashboard usa a mesma contagem consolidada.

## Logs sob demanda

Clique em **Exibir logs** na linha do serviço para iniciar `docker compose logs --follow --tail 100 --no-color <serviço>`. Iniciar containers não inicia captura de logs. Apenas um painel é mantido aberto; fechar, trocar de serviço, recolher o projeto, varrer novamente ou fechar a janela encerra a captura correspondente, sem parar o container.

O painel mantém no máximo 100 linhas (até 8.000 caracteres por linha). A captura é somente de leitura e mostra stdout/stderr do serviço escolhido, incluindo suas réplicas. O monitoramento periódico de status e portas continua independente dos logs.

## Busca, favoritos e grupos

A busca encontra projetos pelo nome/caminho e serviços pelo nome/imagem. Os filtros **Em execução**, **Parados** e **Com falhas** restringem os serviços exibidos, incluindo projetos parcialmente ativos. Falhas incluem containers não saudáveis, containers mortos e erros de consulta ao Compose. O dashboard continua mostrando o workspace completo.

Clique na estrela para favoritar e priorizar um projeto. O campo **Grupo** aceita um nome livre ou um grupo já existente; limpe o campo para remover a associação. Favoritos e grupos são salvos localmente por caminho de projeto e restaurados ao reabrir. Use **Só favoritos** e o seletor de grupo para restringir a listagem.

Alterar qualquer filtro limpa as seleções e fecha os painéis de logs/métricas. Selecionar todos considera somente os projetos ou serviços visíveis; ações no projeto inteiro continuam explicitamente identificadas como **Iniciar projeto** e **Parar projeto**.

## Atalhos e métricas

Cada tag de porta permite **Copiar** o endereço do host. Portas TCP de serviços ativos também permitem **Abrir HTTP** no navegador padrão (HTTPS para destinos 443/8443). Endereços de publicação genéricos usam `localhost`, e IPv6 específico usa colchetes. A abertura é um atalho explícito: portas de bancos ou outros protocolos TCP não passam a oferecer HTTP por causa dele.

Clique em **Métricas** no serviço para consultar CPU e memória de cada container/réplica em execução. O painel atualiza a cada três segundos e mantém até 120 amostras locais por container para visualizar a tendência recente; cada série é limitada a 100 containers. Os limites de CPU e memória são configuráveis por projeto/contexto/serviço. Ao ultrapassá-los, o painel destaca o valor e, se as notificações estiverem habilitadas, envia um alerta desktop. Fechar ou recolher o projeto remove o painel. Serviços parados informam que não há containers ativos.

## Contextos e opções do Compose

O seletor **Contexto Docker** lista os contextos disponíveis no CLI e aplica a seleção às consultas, ações, logs, métricas e recursos. A escolha fica salva localmente. Use **Opções do Compose** em cada projeto para ativar perfis e selecionar um arquivo `.env` localizado na raiz do projeto; a lista inclui arquivos `.env` e `.env.*` regulares, não segue links simbólicos e nunca exibe seus valores. As opções são aplicadas às operações daquele projeto e persistidas localmente.

## Ações, presets e dependências

Além de iniciar/parar, o projeto oferece **Pull**, **Build** e **Recriar**. As ações em serviços selecionados continuam disponíveis; a inicialização padrão não inicia dependências automaticamente. A opção **Iniciar com dependências** e o mapa de dependências usam a relação `depends_on` da configuração Compose.

Presets permitem salvar grupos de serviços com um nome e iniciar ou parar esse conjunto em um clique. Eles são armazenados no navegador local e associados ao caminho do projeto.

## Terminal, diagnóstico e recursos

**Terminal** abre um shell `sh` no container do serviço selecionado, com entrada e saída de texto. Ele usa `docker compose exec -i -T` sem pseudo-terminal, portanto é um shell de linha de comando (não um terminal gráfico interativo); fechar o painel encerra o processo. É necessário que o serviço esteja em execução e tenha `sh`.

**Diagnóstico** verifica problemas comuns da configuração, containers órfãos e portas publicadas declaradas em mais de um serviço. O inventário de **Volumes e redes** mostra recursos Compose identificados pelo projeto. A remoção exige confirmação e só é permitida para recursos marcados com o projeto, sem containers associados; o backend repete a validação antes de remover.

Use **Ativar notificações** para solicitar permissão do sistema. Notificações de estado são enviadas quando um container muda para `unhealthy`/`dead` ou se recupera; o painel de métricas também pode notificar limites de CPU/memória. O sistema operacional pode exigir uma permissão adicional. Os alertas de recursos dependem do painel de métricas estar aberto.

## Pesquisa e exportação de logs

No painel de logs, combine busca textual e **Somente erros** (error, fail/failed/failure, fatal, panic e exception). Os filtros não reiniciam a captura. **Exportar exibidos** salva somente as linhas que passaram pelos filtros em um arquivo `.log` UTF-8 na pasta de Downloads do sistema, com nome do serviço e identificador temporal, sem sobrescrever exportações anteriores. O caminho salvo ou o erro é exibido no próprio painel.

É necessário Docker com o plugin Compose compatível com saída JSON e acesso ao daemon do contexto selecionado. O terminal depende de containers em execução com `sh`; o suporte a contextos, métricas, notificações e recursos também depende das capacidades disponíveis no Docker, no sistema operacional e na compilação Tauri.

## Desenvolvimento

Execute `npm run tauri dev` para abrir o aplicativo. Após alterações em Rust, reinicie/recompile o aplicativo Tauri; atualizar somente o frontend não registra os novos comandos.

Validação: `npm run build`, `npm test` e `cargo test --manifest-path src-tauri/Cargo.toml --lib`. Os testes Node usam suporte nativo a TypeScript (Node 22.18+ ou 24+).

Execute `npm run test:browser` para conferir seleção de serviços, ações em lote, atualização dos botões e respostas atrasadas em uma instância isolada do Chromium, com Docker simulado. O navegador padrão é `chromium`; use `CHROME_BIN` para informar outro caminho. Esses testes não iniciam nem param containers reais.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
