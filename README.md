# backcode-runner

Runner local de **Backcode**. Escucha las tareas que **tú** aceptas en la app y las implementa con **Claude Code en tu
ordenador**, cada una en su rama (`backcode/<tu-handle>/<tarea>`), y te deja un **PR en borrador** en GitHub o Bitbucket.
Un runner atiende **un proyecto**; puedes tener tantos activos como proyectos.

## Requisitos
- macOS o Linux (el sandbox del sistema es obligatorio) y Node 22 o superior
- [Claude Code](https://claude.com/claude-code) con tu sesión iniciada: ejecuta `claude` una vez y haz login
- `git` con permiso de push al repositorio del proyecto
- Para abrir PRs:
  - **GitHub**: `gh auth login`
  - **Bitbucket**: un API token (ver más abajo; `npm run connect` te lo pide)
- Para publicar OTA (proyectos Expo): `npx eas-cli login` con una cuenta con acceso al proyecto de Expo

## Conectar un proyecto
1. En la app: **Proyecto → Conectar paso a paso**. Indica la carpeta del repo en tu ordenador, la rama base y dónde abrir los PR
   (GitHub, Bitbucket o solo subir la rama), y copia la configuración.
2. En la carpeta del runner:
   ```bash
   git clone https://github.com/hernanmateo/backcode-runner.git && cd backcode-runner   # solo la primera vez
   npm install
   npm run connect     # pega la configuración (⌘V) y pulsa Enter
   ```
   `npm run connect` la guarda en `.env.<proyecto>` (permisos 600, solo tú puedes leerlo) y arranca el runner.
   En la app verás **"¡Tu Claude Code está conectado!"** y en la terminal los siguientes pasos.

**La llave (runner key) es por usuario, no por proyecto.** Solo hace falta generarla en la app la primera vez en cada ordenador.
Si ya tienes otro proyecto conectado, en la guía elige **"Ya tengo una llave en este ordenador"**: `npm run connect` reutiliza la que
tienes. Generar una nueva revoca la anterior y desconectaría tus otros runners.

## Arrancarlo cada día
```bash
git pull && npm run all        # un runner por cada proyecto conectado, con los logs juntos ([proyecto] delante)
npm start -- --env .env.<id>   # o solo uno
```
Deja la terminal abierta mientras quieras que trabaje. **Ctrl+C** los para: una tarea a medias vuelve a la cola y se retoma al
volver a arrancar. Si lanzas dos runners tuyos para el mismo proyecto, el segundo se niega a arrancar.

## Cambiar la ruta del repo, la rama base o los PR
App → Proyecto → Conectar → **Configurar de nuevo** → cambia lo que quieras → "Ya tengo una llave en este ordenador" → **Copiar
configuración** → `npm run connect` y pegar. Sustituye la configuración de ese proyecto sin tocar los demás.

Al arrancar, el runner comprueba el repo real y se adapta (y te lo avisa en la terminal y en la app):
- Si la rama base configurada no existe (p. ej. el repo usa `master` y no `main`), usa la rama por defecto del repo.
- Si el repo no está en GitHub ni Bitbucket, o es Bitbucket sin token, sube la rama sin abrir PR.

## PRs en Bitbucket (API token)
1. Abre <https://id.atlassian.com/manage-profile/security/api-tokens> con la cuenta con la que entras en Bitbucket.
2. **Create API token with scopes** → ponle nombre y caducidad → app **Bitbucket**.
3. Permisos: `read:user:bitbucket` (imprescindible), `read:repository:bitbucket`, `write:repository:bitbucket`,
   `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`. Copia el token (solo se muestra una vez).
4. En la guía de la app elige **"Abrir PR en Bitbucket"** y, al hacer `npm run connect`, introduce el **email de esa cuenta de
   Atlassian** (no el usuario de Bitbucket) y el token (no se muestra al escribirlo).

El token se guarda solo en tu `.env.<proyecto>` y se reutiliza para tus otros proyectos de Bitbucket. Lo usa el runner para abrir
y mergear PRs; Claude nunca tiene acceso a él.

## Qué hace con cada tarea
1. La reclama (`execute → running`) y verifica que es tuya, que sigues en el grupo y que el encargo y los adjuntos no han cambiado
   desde que la aceptaste (huella).
2. Crea una copia aislada (worktree) en `~/.backcode/worktrees/<proyecto>/<tarea>` sobre su rama, partiendo de `<remoto>/<base>`.
   Tu carpeta de trabajo no se toca. Los adjuntos (capturas, PDFs…) se descargan en `.backcode-attachments/`, excluida de git.
3. Lanza Claude Code con [`instructions/AGENT.md`](instructions/AGENT.md): trabajar solo en esa rama, ejecutar los tests, preguntar
   (`ask_user`) si algo esencial es ambiguo y llamar a `open_pull_request` al terminar.
4. Revisa el resultado (rechaza cambios en rutas protegidas y diffs con secretos), hace commit y push y abre el **PR en borrador**.
5. Marca la tarea como `done` (con el PR), `waiting` (si Claude preguntó) o `failed` (con el motivo). La app muestra la actividad
   en vivo: lo que dice Claude, los comandos, los archivos que toca y el plan.

## Conversación con Claude (hilo por tarea)
- Si Claude necesita una aclaración, la tarea pasa a **Necesita respuesta** y la pregunta aparece en el hilo de la app.
- Quien la aceptó responde (o pide más cambios cuando ya hay PR) desde la app: el runner **retoma la misma sesión** en la misma
  rama, y los commits nuevos actualizan el mismo PR.
- Los worktrees se conservan para poder continuar y se borran tras 14 días sin uso.
- **Seguir en Claude Code:** la app te da el comando (`cd ~/.backcode/worktrees/… && claude --resume <sesión>`). Dentro,
  `/remote-control` la abre en la app móvil de Claude. Ahí trabajas con tus permisos normales, fuera del sandbox del runner.

## Acciones desde la app (las ejecuta tu runner)
Cuando pides algo de esto en la app, lo ejecuta **el runner de quien lo pide**, con sus credenciales; el servidor nunca tiene tus
tokens de GitHub, Bitbucket ni EAS. Los comandos son fijos: nunca los decide Claude.

| Acción | Quién | Qué hace |
|---|---|---|
| **Abrir PR** | cualquier miembro | Para tareas con solo la rama subida: abre el PR (sin volver a ejecutar a Claude). |
| **Mergear PR** | admins y owner | Comprueba que los checks del PR están en verde, lo saca de borrador, hace squash y borra la rama. |
| **Publicar OTA** | admins y owner | Solo en repos Expo con `eas.json`. Comprueba que el último commit de la rama base está en verde, instala dependencias y ejecuta `eas update` al canal **preview** o **production**, siempre al 100 % y para iOS y Android. |

## Mapa e icono del proyecto
Al arrancar (y como mucho una vez al día si cambia la rama base), Claude analiza el repo **en solo lectura** con un modelo barato
(`BACKCODE_KNOWLEDGE_MODEL`, por defecto `haiku`; unos céntimos) y sube un resumen: stack, estructura, módulos, comandos y
convenciones. La IA que prepara los encargos lo usa para escribir prompts con rutas y comandos reales. Solo ve ficheros versionados
(nunca tus `.env` locales), no tiene Bash ni red, y si el resumen parece contener un secreto se descarta. Desactívalo con
`BACKCODE_KNOWLEDGE=off`.

También busca el **icono del proyecto** en el repo (el `expo.icon` de `app.json`, `apple-touch-icon`, `logo`, `favicon`…) leyéndolo
de git y lo sube para mostrarlo en la app, salvo que un admin elija otro.

## Uso y cuota
El runner publica en tu grupo el consumo de cada tarea (tokens y coste estimado) y, si usas un plan Pro o Max, el % usado de tu
cuota de 5 h y semanal (dato orientativo de una API experimental de Claude Code). Lo ves en **Grupo → Uso del equipo**.

## Seguridad
El texto de las tareas lo escriben otros miembros del grupo: se trata como **dato no confiable**.

| Capa | Medida |
|---|---|
| Identidad | La runner key te autentica como tú y está sujeta a las Security Rules: solo puede mover tus tareas. Una nueva revoca la anterior. |
| `.env` | Solo para ti (`chmod 600`; si otros pueden leerlo, el runner no arranca). Las variables `BACKCODE_*` (llave, token de Bitbucket) se borran del entorno antes de lanzar Claude. |
| Disco | Claude solo lee y escribe dentro del worktree. Los comandos corren en el sandbox del sistema y no pueden leer este kit, `~/.ssh`, `~/.aws`, `~/.config/gh`… |
| Red | Los comandos solo llegan a `BACKCODE_ALLOWED_DOMAINS`. No hay WebFetch ni WebSearch. |
| Permisos | En modo `dontAsk`, lo que no está permitido se deniega. Además, un hook bloquea `git push`, `gh`, `curl`, `ssh`, `sudo`… |
| Repo | No se cargan los settings ni los hooks de `.claude/` del repo. CI, `.claude/`, `.mcp.json`, `CLAUDE.md`, `.env*`, claves y adjuntos están protegidos. |
| Publicación | El push y el PR los hace el runner, sin hooks de git, y el PR siempre en **borrador**. El merge y el OTA solo ocurren si un admin los pide desde la app y los checks están en verde. |

Recomendado: protege la rama base del repo (PR y review obligatorios) y revisa cada PR como si viniera de un desconocido.

## Personalizar las instrucciones
Edita [`instructions/AGENT.md`](instructions/AGENT.md). Admite estos marcadores: `{{projectName}}`, `{{worktree}}`, `{{branch}}`,
`{{baseBranch}}`, `{{remote}}`, `{{projectContext}}` y `{{claudeMd}}`. Si quitas reglas de seguridad no se desactivan las barreras
técnicas, pero el agente pierde contexto sobre por qué existen.

## Variables del `.env`
Las genera la app; las puedes ajustar a mano en `.env.<proyecto>`. Ver [`.env.example`](.env.example) para todas
(límites por tarea, modelo, dominios permitidos, rutas protegidas, mapa del proyecto…).
