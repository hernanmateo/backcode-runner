# backcode-runner

Runner local de **Backcode**. Escucha las tareas que **tú** aceptas en la app y las implementa con **Claude Code en tu
ordenador**, cada una en su rama (`backcode/<tu-handle>/<tarea>`), y te deja un **PR en borrador** en GitHub o Bitbucket.
Un runner atiende **un proyecto**; puedes tener tantos activos como proyectos.

## Requisitos
- macOS o Linux (el sandbox del sistema es obligatorio) y Node 22 o superior
- [Claude Code](https://claude.com/claude-code) con tu sesión iniciada: ejecuta `claude` una vez y haz login
- `git` con permiso de push al repositorio del proyecto
- Para abrir PRs:
  - **GitHub**: `gh auth login` (solo si tus repos están en GitHub)
  - **Bitbucket**: un API token (ver más abajo; `npm run connect` te lo pide)
- Para publicar OTA (proyectos Expo): `npx eas-cli login` con una cuenta con acceso al proyecto de Expo y, si el repo publica con su
  propio script (p. ej. xprem), lo que ese script necesite en tu copia local (p. ej. `EOO_TOKEN` en el `.env`)

## Conectar un proyecto
1. En la app: **Proyecto → Conectar paso a paso**. Primero el proyecto: la carpeta del repo en tu ordenador, la rama base y dónde
   abrir los PR (GitHub, Bitbucket o solo subir la rama); eso decide qué hace falta preparar en el ordenador.
2. En la carpeta del runner lanza `npm run connect`: se queda esperando la configuración.
   ```bash
   git clone https://github.com/hernanmateo/backcode-runner.git && cd backcode-runner   # solo la primera vez en este ordenador
   npm install                                                                          # solo la primera vez
   npm run connect
   ```
3. Ahora, en la app, **Copiar configuración** y pégala en esa terminal (⌘V) + Enter. (En este orden para que copiar el comando no
   pise la configuración en el portapapeles.)
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

`npm run connect` **comprueba el token** contra la API de Bitbucket antes de guardarlo y, si falla, te dice por qué (email o
token incorrectos, falta un permiso o no tienes acceso al repo) y te deja reintentarlo. Si el guardado deja de valer (caduca o lo
cambias), te pide otro y lo actualiza en todos tus proyectos de Bitbucket. El token se guarda solo en tu `.env.<proyecto>`. Lo usa el runner para abrir
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
Por defecto, cada tarea usa el **modelo por defecto de tu Claude Code** (con un plan Max, Opus), o `BACKCODE_MODEL` si lo has
puesto. En la tarea se puede fijar uno: **Haiku, Sonnet, Opus o Fable** (Fable se pasa con su id completo, `claude-fable-5-1`). Al
refinar, la IA **recomienda** el más barato que lo hará bien según la complejidad, con el motivo; se aplica con un toque, nunca sola.
Opus y Fable gastan la cuota del plan bastante más deprisa. La ficha muestra el coste y los tokens por modelo realmente usado.

## Conversación con Claude (hilo por tarea)
- Si Claude necesita una aclaración, la tarea pasa a **Necesita respuesta** y la pregunta aparece en el hilo de la app.
- Quien la aceptó responde (o pide más cambios cuando ya hay PR) desde la app: el runner **retoma la misma sesión** en la misma
  rama, y los commits nuevos actualizan el mismo PR.
- Los worktrees se conservan para poder continuar y se borran tras 14 días sin uso.
- **Seguir en Claude Code:** la app te da el comando (`cd ~/.backcode/worktrees/… && claude --resume <sesión>`). Dentro,
  `/remote-control` la abre en la app móvil de Claude. Ahí trabajas con tus permisos normales, fuera del sandbox del runner.

## PRs mergeados fuera de la app
Si alguien mergea el PR de una de tus tareas a mano en GitHub o Bitbucket, tu runner lo detecta (cada 5 minutos) y la marca como
**Mergeada** con su commit; la siguiente OTA la marcará como **Desplegada**.

## Conflictos con la rama principal
Si otro PR se mergea antes y toca lo mismo que tu tarea, tu runner lo detecta (cada 5 minutos, solo cuando cambia alguna de las dos
ramas; con git ≥ 2.38 sin tocar nada, con versiones anteriores en una copia temporal) y la tarea muestra **⚠️ Choca con la rama
principal** con los ficheros. Pulsa **Actualizar con main**: al retomar la tarea, el runner mezcla lo último de la rama principal en
la rama de la tarea; si no hay conflictos lo sube ya, y si los hay Claude los resuelve conservando los dos cambios, pasa los tests y
el mismo PR se actualiza. Las rutas protegidas y los secretos se revisan solo sobre lo que cambia la tarea, no sobre lo que entró en
la rama principal. Esto pasa siempre que se retoma una tarea (también al responder en el hilo).

## Acciones desde la app (las ejecuta tu runner)
Cuando pides algo de esto en la app, lo ejecuta **el runner de quien lo pide**, con sus credenciales; el servidor nunca tiene tus
tokens de GitHub, Bitbucket ni EAS. Los comandos son fijos: nunca los decide Claude.

| Acción | Quién | Qué hace |
|---|---|---|
| **Abrir PR** | cualquier miembro | Para tareas con solo la rama subida: abre el PR (sin volver a ejecutar a Claude). |
| **Mergear PR** | admins y owner | Comprueba que los checks del PR están en verde, lo saca de borrador, hace squash y borra la rama. Después pone al día tu copia local (ver abajo). |
| **Publicar OTA** | admins y owner | Solo en apps Expo con OTA configurado (ver abajo). Comprueba que el último commit de la rama base está en verde, instala dependencias y publica al canal **preview** o **production**, siempre al 100 % y para iOS y Android. |
| **Build para testers** | admins y owner | Build local con EAS (iOS y/o Android) con la versión y runtimeVersion escritas en la app, y envío a TestFlight / Internal Testing (ver abajo). |

### Tu copia local se pone al día sola
Tras mergear desde la app, y cada vez que arranca el runner, tu copia local de la rama base se actualiza con lo que hay en el
remoto, **solo si es seguro**: estás en la rama base sin cambios pendientes y es un avance limpio (fast-forward). Si estás en otra
rama, se avanza la rama base sin cambiar de rama. Si cambiaron dependencias (`package.json` o lockfile), instala con el gestor del
repo (`pnpm`/`yarn`/`bun install --frozen-lockfile` o `npm install`). Si algo no cuadra (cambios sin guardar, commits locales que
no están en el remoto), no toca nada y lo avisa en la terminal para que hagas `git pull` tú.

### Cómo publica el OTA cada proyecto
El runner lo detecta al arrancar, leyendo la rama base:
1. **Script propio**: si el `package.json` de la app tiene `ota:publish` (p. ej. un servidor **xprem** propio), ejecuta
   `<pnpm|yarn|npm> run ota:publish <rama> --yes -m "<mensaje>"` en una copia limpia de la rama base. El runner le pasa `prod` o
   `preview` y el script de cada repo los traduce a sus ramas reales de xprem (p. ej. Castellers usa `prod`/`preview` y Backcode
   `main`/`dev`). Se copian a esa copia los `.env`/`.env.local`
   locales ignorados por git (el script saca de ahí su token) y el registro de la última publicación (`.expo/eoas-last-publish-*`)
   para que su guarda de cambios nativos funcione; la copia se borra al acabar. Nunca se pasa `--allow-native` ni porcentajes:
   si el script se niega, la app muestra su motivo.
2. **EAS Update**: si la config de Expo tiene `updates.url` en `u.expo.dev`, ejecuta `eas update --channel <canal>`.
3. Si no hay ninguno, no se ofrece OTA y la terminal lo avisa (EAS Update se activa con `npx eas-cli update:configure`).

Tras publicar, las tareas mergeadas desde la app cuyo commit de merge va incluido en lo publicado quedan marcadas como
**Desplegadas** en ese canal (preview o production).

**Rollback rápido:** desde la pantalla de OTA, un admin puede volver a publicar la versión anterior de un canal. El runner solo
acepta commits que ya están en la rama base y no espera checks (esa versión ya se publicó); pasa por el mismo script o `eas update`.

El script vive en el repo y se ejecuta con tus credenciales: solo se usa el de la rama base, que ya ha pasado por review.

### Builds para testers (TestFlight / Internal Testing)
En la misma pantalla de publicar, pestaña **Build para testers** (solo admins y owner; se ofrece si el `eas.json` tiene el perfil
`production`). Es un binario nuevo, no un OTA: el admin elige iOS y/o Android y escribe la **versión** (`1.0.16`) y la
**runtimeVersion** (por defecto, la misma que la versión). El runner, en una copia limpia de la rama base y con los checks en verde:
1. Instala dependencias y comprueba con `expo config` que la app aplica la versión pedida: la recibe en `APP_VERSION` y
   `RUNTIME_VERSION`, y su `app.config.js` tiene que leerlas (ver `app/app.config.js` de Backcode). Si no, falla sin compilar.
2. Por plataforma: `eas build --local --profile production` (en tu ordenador; iOS solo en un Mac con Xcode) y
   `eas submit --path <binario>`: iOS va a TestFlight y Android al track del perfil de submit (`internal` por defecto).

Usa tu sesión de EAS y las credenciales de las tiendas que tengas en EAS (`eas credentials`); no se copia ningún `.env` local ni
se toca `ios/`/`android/`. El número de build lo gestiona EAS (`appVersionSource: remote` + `autoIncrement`).

## Mapa e icono del proyecto
Al arrancar (y como mucho una vez al día si cambia la rama base), Claude analiza el repo **en solo lectura** con un modelo barato
(`BACKCODE_KNOWLEDGE_MODEL`, por defecto `haiku`; unos céntimos) y sube un resumen: stack, estructura, módulos, comandos y
convenciones. La IA que prepara los encargos lo usa para escribir prompts con rutas y comandos reales. Solo ve ficheros versionados
(nunca tus `.env` locales), no tiene Bash ni red, y si el resumen parece contener un secreto se descarta. Desactívalo con
`BACKCODE_KNOWLEDGE=off`.

También busca el **icono del proyecto** en el repo (el `icon` de `app.json` o de `app.config.js/ts`, `apple-touch-icon`, `logo`,
`favicon`…; si la config de Expo no lo dice, usa la ruta que propone la IA al generar el mapa, siempre que exista en el repo y sea
una imagen válida) leyéndolo
de git y lo sube para mostrarlo en la app, salvo que un admin elija otro.

## Uso y cuota
El runner publica en tu grupo el consumo de cada tarea (tokens y coste estimado) y, si usas un plan Pro o Max, el % usado de tu
cuota de 5 h y semanal (dato orientativo de una API experimental de Claude Code). Lo ves en **Grupo → Uso del equipo** y en el
perfil de cada miembro. La cuota se lee al arrancar, tras cada tarea, cada 5 minutos y cuando alguien pulsa ↻ en la app (leerla no
llama al modelo ni consume); si tu runner está apagado, se ve la última lectura.

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
