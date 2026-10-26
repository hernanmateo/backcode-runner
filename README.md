# backcode-runner

Runner local de **Backcode**. Escucha (con un snapshot de Firestore) las tareas que **tú** aceptas en la app
para **un** proyecto. Cada una la implementa Claude Code en tu máquina, en una rama propia
(`backcode/<tu-handle>/<id>`), y te deja un **PR en borrador**.

## Requisitos
- Node 22 o superior
- [Claude Code](https://claude.com/claude-code) con la sesión iniciada (`claude`)
- `git` con acceso de push al repositorio, y `gh auth login` si usas PRs de GitHub
- macOS o Linux (el sandbox del sistema es obligatorio)

## Puesta en marcha
```bash
git clone https://github.com/hernanmateo/backcode-runner.git && cd backcode-runner
npm install
npm run connect   # pega la configuración que te da la app (Proyecto → Conectar mi Claude Code)
```
`npm run connect` guarda la configuración en `.env.<proyecto>` (permisos 600) y arranca el runner. Las próximas veces:
`npm start -- --env .env.<proyecto>`.

También puedes hacerlo a mano: `cp .env.example .env && chmod 600 .env`, rellenarlo y `npm start`.

Un `.env` corresponde a un proyecto. Para trabajar en varios, crea un fichero por proyecto y lanza un runner por cada uno:
```bash
npm start -- --env .env.web
npm start -- --env .env.api
```
Si lanzas dos runners tuyos para el mismo proyecto, el segundo se niega a arrancar.

## Mapa del proyecto
Al arrancar (y como mucho una vez al día si cambia la rama base), Claude analiza el repo **en solo lectura** con un modelo barato
(`BACKCODE_KNOWLEDGE_MODEL`, por defecto `haiku`; unos céntimos) y sube un resumen: stack, estructura, módulos, comandos y convenciones.
La IA que prepara los encargos lo usa para escribir prompts con rutas y comandos reales. Solo ve ficheros versionados (nunca tus `.env`
locales), no tiene Bash ni red, y si el resumen parece contener un secreto se descarta. Desactívalo con `BACKCODE_KNOWLEDGE=off`.

## Qué hace con cada tarea
1. La reclama de forma atómica (`execute → running`) y comprueba tres cosas: que es tuya, que sigues en el grupo y que el prompt no ha cambiado desde que la aceptaste (hash).
2. Crea un worktree aislado en `~/.backcode/worktrees/<proyecto>/<tarea>` sobre la rama asignada, partiendo de `origin/<base>`. Tu checkout de trabajo no se toca.
3. Lanza Claude Code con las instrucciones de [`instructions/AGENT.md`](instructions/AGENT.md): trabajar solo en esa rama, ejecutar los tests y llamar a `open_pull_request` al terminar.
4. Revisa el resultado: rechaza cambios en rutas protegidas y diffs con secretos. Después hace commit y push, y ejecuta `gh pr create --draft`.
5. Marca la tarea como `done` (con el enlace al PR) o `failed` (con el motivo), y en la app aparece la actividad en tiempo real.

## Seguridad
El texto de las tareas lo escriben otros miembros del grupo: se trata como **dato no confiable**.

| Capa | Medida |
|---|---|
| Identidad | La runner key te autentica como tú y está sujeta a las Security Rules: solo puede mover tus tareas. Si generas una nueva en la app, la anterior queda revocada. |
| `.env` | Solo para ti (`chmod 600`; el runner no arranca si otros pueden leerlo). Las variables `BACKCODE_*` se borran del entorno antes de lanzar Claude. |
| Disco | Claude solo lee y escribe dentro del worktree. Los comandos corren en el sandbox del sistema y no pueden leer este kit, `~/.ssh`, `~/.aws`, `~/.config/gh`… |
| Red | Los comandos solo llegan a `BACKCODE_ALLOWED_DOMAINS`. No hay WebFetch ni WebSearch. |
| Permisos | En modo `dontAsk`, lo que no está permitido se deniega. Además, un hook bloquea `git push`, `gh`, `curl`, `ssh`, `sudo`… |
| Repo | No se cargan los settings ni los hooks de `.claude/` del repo. CI, `.claude/`, `.mcp.json`, `CLAUDE.md`, `.env*` y las claves están protegidos. |
| Publicación | El push lo hace el runner, sin hooks de git, y siempre como **PR en borrador**. Nunca hace merge. |

Recomendado: protege la rama base del repo (PR y review obligatorios) y revisa cada PR como si viniera de un desconocido.

## Personalizar las instrucciones
Edita [`instructions/AGENT.md`](instructions/AGENT.md). Admite estos marcadores: `{{projectName}}`, `{{worktree}}`, `{{branch}}`,
`{{baseBranch}}`, `{{remote}}`, `{{projectContext}}` y `{{claudeMd}}`. Si quitas reglas de seguridad no se desactivan las barreras técnicas,
pero el agente pierde contexto sobre por qué existen.
