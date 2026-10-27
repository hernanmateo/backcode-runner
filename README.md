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
- Para publicar OTA (proyectos Expo): `npx eas-cli login` con una cuenta con acceso al proyecto de Expo y, si el repo publica con su
  propio script (p. ej. xprem), lo que ese script necesite en tu copia local (p. ej. `EOO_TOKEN` en el `.env`)

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
tienes. Generar una nueva revoca la anterior; si lo haces, `npm run connect` comprueba la llave contra el servidor y copia la
válida a tus otras configuraciones (reinicia esos runners para que la usen). Si no encuentra ninguna válida, te pide generar una.

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

## Modelo de cada tarea
Al refinar una idea, la IA sugiere un modelo según la complejidad: **Haiku** (cambios triviales), **Sonnet** (la mayoría) u
**Opus** (cambios grandes o delicados), con el motivo. En la tarea se elige **Auto** (usa el sugerido) o uno fijo; cualquiera
puede cambiarlo antes de aceptarla y, después, quien la aceptó mientras no se está ejecutando. Si la tarea no trae modelo, se
usa `BACKCODE_MODEL` o, si está vacío, el de tu Claude Code. La ficha de la tarea muestra el coste y los tokens **por modelo**
realmente usado (Claude Code puede usar otros para subtareas).

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
| **Mergear PR** | admins y owner | Comprueba que los checks del PR están en verde, lo saca de borrador, hace squash y borra la rama. Después pone al día tu copia local (ver abajo). |
| **Publicar OTA** | admins y owner | Solo en apps Expo con OTA configurado (ver abajo). Comprueba que el último commit de la rama base está en verde, instala dependencias y publica al canal **preview** o **production**, siempre al 100 % y para iOS y Android. |

### Tu copia local se pone al día sola
Tras mergear desde la app, y cada vez que arranca el runner, tu copia local de la rama base se actualiza con lo que hay en el
remoto, **solo si es seguro**: estás en la rama base sin cambios pendientes y es un avance limpio (fast-forward). Si estás en otra
rama, se avanza la rama base sin cambiar de rama. Si cambiaron dependencias (`package.json` o lockfile), instala con el gestor del
repo (`pnpm`/`yarn`/`bun install --frozen-lockfile` o `npm install`). Si algo no cuadra (cambios sin guardar, commits locales que
no están en el remoto), no toca nada y lo avisa en la terminal para que hagas `git pull` tú.

### Cómo publica el OTA cada proyecto
El runner lo detecta al arrancar, leyendo la rama base:
1. **Script propio**: si el `package.json` de la app tiene `ota:publish` (p. ej. un servidor **xprem** propio), ejecuta
   `<pnpm|yarn|npm> run ota:publish <rama> --yes -m "<mensaje>"` en una copia limpia de la rama base. La rama es `preview` o
   `prod` (en xprem, el canal `production` del binario apunta a la rama `prod`). Se copian a esa copia los `.env`/`.env.local`
   locales ignorados por git (el script saca de ahí su token) y el registro de la última publicación (`.expo/eoas-last-publish-*`)
   para que su guarda de cambios nativos funcione; la copia se borra al acabar. Nunca se pasa `--allow-native` ni porcentajes:
   si el script se niega, la app muestra su motivo.
2. **EAS Update**: si la config de Expo tiene `updates.url` en `u.expo.dev`, ejecuta `eas update --channel <canal>`.
3. Si no hay ninguno, no se ofrece OTA y la terminal lo avisa (EAS Update se activa con `npx eas-cli update:configure`).

Tras publicar, las tareas mergeadas desde la app cuyo commit de merge va incluido en lo publicado quedan marcadas como
**Desplegadas** en ese canal (preview o production).

El script vive en el repo y se ejecuta con tus credenciales: solo se usa el de la rama base, que ya ha pasado por review.

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
