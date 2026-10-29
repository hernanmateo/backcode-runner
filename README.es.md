# backcode

[English](README.md) · **Español**

Runner local de **Backcode**. Escucha las tareas que **tú** aceptas en la app y las implementa con **Claude Code en tu
ordenador**, cada una en su rama (`backcode/<tu-handle>/<tarea>`), y te deja un **PR en borrador** en GitHub o Bitbucket.
Atiende todos los proyectos que conectes en este ordenador (un proceso por proyecto) y trae un **panel** en el navegador para
conectarlos y gestionarlos sin usar la terminal.

Código abierto bajo [Apache-2.0](LICENSE): corre en tu ordenador y con acceso a tus repos, así que puedes leer exactamente qué hace.

## Empezar
**En un Mac:** descarga [Backcode-Runner.dmg](https://github.com/hernanmateo/backcode-runner/releases/latest/download/Backcode-Runner.dmg)
(universal, firmada y notarizada), arrastra **Backcode Runner** a Aplicaciones y ábrela. Sin Terminal ni Node: copia el runner a
`~/.backcode/bin`, lo deja arrancando al iniciar sesión y abre el panel. Volver a abrir la app solo abre el panel.

**En Linux (o desde la Terminal de un Mac):** pega esto:
```bash
curl -fsSL https://raw.githubusercontent.com/hernanmateo/backcode-runner/main/install.sh | sh
```
Instala un único ejecutable en `~/.backcode/bin` (**sin Node**), comprueba su SHA-256, deja `backcode` en el PATH (una línea
en el perfil de tu shell) y abre el **panel** en el navegador (http://127.0.0.1:47474). Las próximas veces: `backcode`.
¿Ya usas Node? Es el mismo runner desde npm: `npx backcode`.

### Todas las formas de instalarlo
Todas instalan el mismo runner y abren el mismo panel.

| Forma | Cómo | Para quién |
|---|---|---|
| **App de Mac** (la más fácil) | [Backcode-Runner.dmg](https://github.com/hernanmateo/backcode-runner/releases/latest/download/Backcode-Runner.dmg) → Aplicaciones → abrir | Cualquiera con macOS. Sin Terminal ni Node |
| **Un comando** | `curl -fsSL https://raw.githubusercontent.com/hernanmateo/backcode-runner/main/install.sh \| sh` | Linux o la Terminal de un Mac. Sin Node |
| **npm sin instalar** | `npx backcode` | Si ya usas Node 22+ |
| **npm global** | `npm install -g backcode` y después `backcode` | Usuarios de Node que quieren el comando a mano |
| **Plugin de Claude Code** | En Claude Code: `/plugin marketplace add hernanmateo/backcode-runner`, `/plugin install backcode@backcode` y después `/backcode:setup` | Si trabajas en Claude Code: lo instala, conecta y arregla todo contigo |
| **Desde el código** | `git clone … && npm install && npm run panel` | Para contribuir |

Más: una versión concreta (`BACKCODE_VERSION=1.0.0` en `install.sh`, o `npx backcode@1.0.0`), sin abrir el panel
(`BACKCODE_NO_OPEN=1`), solo el ejecutable (`backcode-<os>-<arch>` de la Release, con `SHA256SUMS`) o en un servidor sin navegador
(`backcode connect` + `backcode service install`).

**Plugin de Claude Code.** Cada persona lo instala una vez en su Claude Code:

```text
/plugin marketplace add hernanmateo/backcode-runner
/plugin install backcode@backcode
```

El marketplace se lee del repo público `hernanmateo/backcode-runner`: si ese repo se pone privado, deja de funcionar para quien
no tenga acceso, y habría que publicar el marketplace (`.claude-plugin/` y `plugins/`) en un repo público, p. ej. el de las
releases.

`/backcode:setup` hace la puesta en marcha conversando contigo (comprueba el ordenador, instala el
runner, te ayuda con GitHub, conecta el proyecto leyendo la configuración del portapapeles —nunca por el chat—, encuentra o
clona el repo y lo deja arrancando al iniciar sesión) y `/backcode:doctor` diagnostica y arregla lo que falle. Usa los mismos
comandos: `backcode status` (resumen sin secretos) y `pbpaste | backcode connect --clone --no-start` (`--repo <ruta>` si el repo
está en otra carpeta). El plugin vive en `plugins/backcode/` y el marketplace en `.claude-plugin/marketplace.json`; se comprueban
con `claude plugin validate .`.

**Pautas de Backcode fuera de Backcode.** Un admin elige en la app, en **Editar proyecto › Pautas de Backcode fuera de
Backcode**, cómo se trabaja en el repo con Claude Code directamente (con el plugin):
- **Desactivado**: Claude Code trabaja como siempre.
- **Recordar**: al empezar cada sesión en ese repo (o en un worktree suyo), el plugin le da a Claude las pautas: cada
  funcionalidad o fix en su worktree y su rama desde la base al día, y a la rama principal solo por PR.
- **Exigir**: además, un `git commit` en la rama principal o un `git push` que la suba (`main`, `HEAD:main`, `--all`…) pide
  confirmación antes de ejecutarse. Pregunta en vez de bloquear: hay casos legítimos (p. ej. publicar una release).

Para el trabajo en sí, **`/backcode:feature`**, o a mano:
- `backcode task start "<título>"`: worktree en `~/.backcode/worktrees/<proyecto>/<id>` con la rama `backcode/<handle>/<id>`
  desde `<remoto>/<base>` (trae la base antes) y los `.env` locales copiados.
- `backcode task pr --title "…" --body-file pr.md` (desde ese worktree): comprueba que no hay cambios sin commit ni secretos en
  la rama, la sube, abre (o actualiza) el PR y lo **registra en el tablero** como tarea tuya en «PR listo» (function
  `registerLocalWork`). Desde ahí se mergea, se marca y se despliega como cualquier otra. El runner no la continúa (no tiene su
  sesión): los cambios se siguen haciendo en el worktree y `backcode task pr` actualiza el mismo PR.

El hook no lee la configuración (lleva claves): cada runner deja en `~/.backcode/guard/<proyecto>.json` solo el nombre, la ruta
del repo, la rama base, el remoto y el modo, y `backcode hook session-start|pre-tool-use` decide con eso. Sin runner (o con uno
anterior a esto), el plugin no hace nada. El plugin solo actúa dentro de Claude Code: para que a la rama principal solo se llegue
por PR desde cualquier sitio, activa la protección de rama en GitHub o Bitbucket (la app enlaza los ajustes en modo «Exigir»).

**Desinstalar:** `backcode service uninstall` (para el servicio y lo quita); borra la app y `~/.backcode`;
quita la línea `# Backcode runner` de tu perfil de shell si usaste `install.sh`; con npm, `npm uninstall -g backcode`.

Desde el panel:
- **Este ordenador**: comprueba Claude Code y su sesión, git y GitHub CLI (y Node, solo con npm). Lo que falte se abre en una
  **guía paso a paso** con un botón que lo hace por ti (instalador oficial de Claude Code, iniciar sesión en Claude o pegar una API
  key de Anthropic, **Conectar con GitHub** con un código en el navegador y sin Terminal, GitHub CLI oficial sin Homebrew ni
  administrador, herramientas de Xcode) y el comando por si prefieres hacerlo a mano.
- **Conectar un proyecto**: en la app, **Proyecto → Conectar paso a paso → Copiar configuración**, y en el panel **Pegar
  configuración**. Encuentra solo el repo en tu ordenador (por su remoto) o te ofrece clonarlo con un clic en `~/Backcode/<proyecto>`
  o elegir la carpeta; si los PR van a Bitbucket, te pide el token.
- **Proyectos**: un interruptor por proyecto para activarlo o pararlo (se recuerda: uno parado no arranca solo al volver),
  reiniciarlo, ver su actividad en vivo o quitarlo. Si encuentra proyectos conectados con la versión anterior (`git clone`, p. ej.
  en `~/Projects/backcode-runner`), ofrece **importarlos** (los copia; no borra nada de allí).
- **Idioma**: el que elijas arriba a la derecha (español, inglés o catalán); si no, el de tu perfil en la app y, mientras no lo
  sepa, el del navegador. Mismos colores e icono que la app, en claro u oscuro según el sistema.
- **Arrancar al iniciar sesión**: lo instala como servicio de tu usuario (launchd en macOS, systemd `--user` en Linux). Corre en
  segundo plano sin terminal, se reinicia si se cae y se actualiza solo. Para volver al panel: `npx backcode`. Desactivarlo
  no para nada: lo que está en marcha sigue hasta que cierres sesión, y la próxima vez ya no arranca solo (abrir la app de Mac
  tampoco lo vuelve a activar; solo abre el panel).
- **Tareas directas de los admins (decretazos)**: muestra si los admins pueden poner tareas en tu runner sin preguntarte (lo leen
  los runners de tu perfil, en vivo). Solo se ve: se cambia en la app, Perfil › Decretazos (un runner no toca tu perfil).
- **Encendido / Apagado** (arriba, junto al modo): el interruptor general. Apagado para todos los runners (una tarea a medias
  vuelve a la cola) y ninguno arranca, ni al reiniciar el panel ni con proyectos nuevos, hasta volver a encenderlo. Se recuerda.

Sin el servicio, los runners funcionan mientras esté abierta la terminal donde lanzaste el panel (Ctrl+C los para).

## Requisitos
- macOS o Linux (el sandbox del sistema es obligatorio). Node 22 solo si lo usas desde npm.
- [Claude Code](https://docs.claude.com/claude-code) con tu sesión iniciada: `curl -fsSL https://claude.ai/install.sh | bash` (o
  el botón del panel), ejecuta `claude` una vez y haz login. El ejecutable usa ese Claude Code; con npm, el que trae el Agent SDK
  (no instales con `--omit=optional`), que comparte tu sesión. El panel (y `backcode connect`) lo comprueban antes de pedirte nada.
- `git` con permiso de push al repositorio del proyecto
- Para abrir PRs:
  - **GitHub**: `gh auth login` (solo si tus repos están en GitHub)
  - **Bitbucket**: un API token (ver más abajo; el panel te lo pide al conectar)
- Para publicar OTA (proyectos Expo): `npx eas-cli login` con una cuenta con acceso al proyecto de Expo y, si el repo publica con su
  propio script (p. ej. xprem), lo que ese script necesite en tu copia local (p. ej. `EOO_TOKEN` en el `.env`)

## Desde la terminal
Todo lo del panel se puede hacer también con comandos (`npm i -g backcode` deja `backcode` en el PATH; si no, delante
`npx backcode`):

| Comando | Qué hace |
|---|---|
| `backcode` | Abre el panel (si ya está abierto, por ejemplo como servicio, solo lo abre en el navegador). |
| `backcode connect` | Conecta un proyecto: pega la configuración de la app (⌘V + Enter). Si el panel está en marcha, lo arranca él; si no, en esta terminal. |
| `backcode start [proyecto…]` | Arranca en esta terminal todos los proyectos (o los indicados), con los logs juntos (`[proyecto]` delante). |
| `backcode service install` / `uninstall` / `status` | Arrancar al iniciar sesión (lo mismo que el interruptor del panel). Log en `~/.backcode/logs/service.log`. |
| `backcode --version` | Versión instalada. |

Si lanzas dos runners tuyos para el mismo proyecto (en dos ordenadores o dos terminales), el segundo se niega a arrancar.

## Dónde guarda las cosas
| Ruta | Qué |
|---|---|
| `~/.backcode/config/<proyecto>.env` | Configuración de cada proyecto, con tu runner key y, si usas Bitbucket, el token (carpeta 700, ficheros 600; si otros pueden leerlo, no arranca). |
| `~/.backcode/config/credentials` | Credenciales de tu cuenta para todos los proyectos: el API token de Bitbucket (600). El `.env` de un proyecto, si trae el suyo, manda. |
| `~/.backcode/config/panel-token` | Token del panel (va en el enlace que abre `backcode`). |
| `~/.backcode/worktrees/<proyecto>/<tarea>` | Copias de trabajo de cada tarea. |
| `~/.backcode/bin/backcode` | El ejecutable sin Node que instala `install.sh` (se actualiza solo desde GitHub Releases). |
| `~/.backcode/app` | Con npm: instalación propia del runner que usa el servicio (y que se actualiza sin permisos de administrador). |
| `~/.backcode/state.json` | Proyectos que paraste en el panel (no se arrancan solos). |

Claude no puede leer `~/.backcode/config`, `~/.backcode/logs` ni la carpeta del runner. `BACKCODE_HOME` cambia la raíz.

**¿Venías de la versión con `git clone`?** Las configuraciones `.env.<proyecto>` de la carpeta del runner se mueven solas a
`~/.backcode/config/` al arrancar, y los comandos de antes (`npm run connect`, `npm run all`, `npm start -- --env .env.<id>`)
siguen funcionando en esa copia. Para pasarte a npm: `npx backcode`, **Importar** en el aviso del panel, para los runners antiguos (Ctrl+C en su
terminal), activa cada proyecto y «Arrancar al iniciar sesión».

## Conectar un proyecto (detalles)
La guía de la app va primero por el proyecto: la carpeta del repo en tu ordenador, la rama base y dónde abrir los PR (GitHub,
Bitbucket o solo subir la rama); eso decide qué hace falta preparar en el ordenador. Al final, **Copiar configuración** y pégala
en el panel (o en `backcode connect`). Se guarda en `~/.backcode/config/<proyecto>.env` y el runner arranca; en la app verás
**"¡Tu Claude Code está conectado!"**.

**¿Dónde está el repo?** No hace falta decirlo. Al conectar, el runner usa, por orden:
1. La ruta de la configuración, si la trae y es un repo git (las configuraciones antiguas la llevan).
2. Un repo de este ordenador cuyo remoto es el del proyecto (`origin`, https o ssh), buscando dos niveles dentro de `~/Projects`,
   `~/Developer`, `~/Code`, `~/code`, `~/dev`, `~/src`, `~/Sites`, `~/apps`, `~/GitHub`, `~/Documents/GitHub`,
   `~/Documents/Projects`, `~/repos`, `~/workspace`, `~/Backcode` y las carpetas donde ya tienes otros proyectos conectados (la
   del repo y la de encima). Lo usa sin preguntar.
3. Si no lo encuentra, el panel ofrece **Clonar en `~/Backcode/<proyecto>`** (si el proyecto ya tiene URL: la guarda el runner del
   primero que conecta; solo GitHub o Bitbucket, sin credenciales), **Elegir carpeta…** (selector de macOS) o uno de los repos
   que ha encontrado. Los repos de GitHub se clonan por https con la sesión de **Conectar con GitHub** (sin claves ssh).
En la terminal (`backcode connect`), si no lo encuentra, pregunta si lo clona; si contestas que no, te pide la ruta del repo
(o pásala con `--repo <ruta>`). También puedes indicarla en la app al copiar la configuración (**Ruta del repo · indicarla**). Desde el panel git no puede pedir contraseñas:
con GitHub, conecta antes GitHub en el panel; con Bitbucket, que tu git tenga credenciales (o clónalo tú).

**GitHub sin terminal.** El panel instala GitHub CLI si falta (Homebrew si lo tienes; si no, el binario oficial de
github.com/cli/cli con su SHA-256, en `~/.backcode/bin/gh`, sin administrador) y **Conectar con GitHub** inicia la sesión con el
código de un solo uso en el navegador (`gh auth login --web` por detrás; la sesión queda en tu llavero, como si lo hicieras tú).
git usa esa sesión para clonar y hacer push solo dentro de los procesos del runner (variables `GIT_CONFIG_*`): tu `~/.gitconfig`
no cambia y Claude no la hereda.

**API key de Anthropic.** Si usas Claude Code con una API key en vez de un plan Pro o Max, pégala en el panel («Sesión de
Claude»): se comprueba con Anthropic, se guarda en `~/.backcode/config/anthropic-key` (600) y los runners se reinician con ella.

**La llave (runner key) es por usuario, no por proyecto.** Solo hace falta generarla en la app la primera vez en cada ordenador.
Si ya tienes otro proyecto conectado, en la guía elige **"Ya tengo una llave en este ordenador"**: se reutiliza la que tienes.
Generar una nueva revoca la anterior; si lo haces, al conectar se comprueba la llave contra el servidor y se copia la válida a
tus otras configuraciones (reinicia esos runners para que la usen). Si no encuentra ninguna válida, te pide generar una.

## Idioma
La terminal, la actividad de las tareas y los errores que ves en la app salen en **el idioma de tu perfil en la app** (español,
inglés o catalán; cambiarlo en la app aplica sin reiniciar). Claude también te escribe en ese idioma (preguntas, resúmenes y
mensaje final). Antes de iniciar sesión (el panel, `backcode connect`, errores al arrancar) se usa el del sistema (`LANG`/`LC_ALL`).
`BACKCODE_LANG=es|en|ca` (en el entorno o en el `.env`) lo fija y manda sobre todo.

## Actualizaciones
**Se actualiza solo.** Con el ejecutable (`install.sh` o la app de Mac), cada 5 minutos mira la última versión en GitHub Releases, descarga la de
tu plataforma, comprueba su SHA-256 contra `SHA256SUMS` y que arranca, y sustituye `~/.backcode/bin/backcode`. Con npm instalado
como servicio (o en `~/.backcode/app`), lo mismo desde npm. En los dos casos, cada runner se reinicia con la versión nueva **al quedar libre** (sin tarea ni acción en marcha; no
interrumpe nada ni coge trabajo nuevo mientras); cuando se han reiniciado todos, el panel también, solo (unos segundos). Si
le das a **Reiniciar el panel**, dice a qué proyecto espera hasta que termine lo que está haciendo.
**La app de Mac** (`Backcode Runner.app`, la ventana) también se pone al día: el servicio descarga el `Backcode-Runner.dmg` de
la última versión, comprueba su SHA-256 y que la app está firmada y notarizada por el mismo equipo que la instalada, y la
sustituye; la ventana abierta sigue con la suya hasta que la vuelvas a abrir.
Si al abrirla el panel no responde en unos 30 segundos (el servicio no arranca, otro programa tiene el puerto 47474…), la
ventana lo dice con **Reintentar** y **Abrir el registro** (`~/.backcode/logs/service.log`) en vez de quedarse cargando.
Si el servicio está instalado pero launchd no lo ha arrancado (en macOS 27 a veces deja el arranque en espera), la app lo
arranca al abrirse.
Con `npx` sin servicio, el panel y la terminal avisan de la versión nueva y basta con volver a lanzar `npx backcode@latest`.

En una copia de git (desarrollo, o quien venía de `git clone`), cada 2 minutos mira si la rama tiene commits nuevos: si los hay y
la copia está limpia, `git pull --ff-only`, `npm install` si cambiaron dependencias, comprueba que compila y se reinicia igual,
al quedar libre. Si tu copia tiene cambios sin guardar o commits locales, o la versión nueva no compila, avisa y sigue con la actual.

**Si el ordenador se apaga o el runner se cae a mitad:** la sesión de Claude se guarda en cuanto empieza y el runner renueva
un «sigo vivo» en la tarea (y en cada acción: merge, OTA, build…). Si deja de renovarlo, la app marca la tarea **Detenida** y
el asignado y los admins reciben un aviso push (una vez por caída). El asignado o un admin puede **reintentarla** (vuelve a su cola; al volver, el runner la continúa donde la dejó), **liberarla**
o **descartarla**. Una acción a medias deja de bloquear publicar a todo el proyecto y sale como *Interrumpida*; al volver,
el runner la marca así (si era un OTA o un merge, comprueba si llegó a hacerse antes de repetirlo).

**Que el ordenador no se duerma a mitad.** Mientras hay una tarea, una acción (merge, OTA, build…) o un refinado en marcha, el
runner impide el reposo por inactividad (macOS: `caffeinate`; Linux: `systemd-inhibit`) y lo suelta al terminar. Con
`BACKCODE_KEEP_AWAKE=always` en el `.env` del proyecto no se duerme mientras el runner esté abierto (útil si quieres que recoja
tareas al momento aunque no estés delante); con `off`, nunca lo impide. Con varios proyectos, basta con que uno tenga `always`.
Cerrar la tapa del portátil sin corriente lo duerme igual.

**Que siga cogiendo tareas cuando no lo usas** (p. ej. fuera de casa). Sin trabajo en marcha, si no lo usas, el ordenador entra
en reposo y tus runners salen desconectados en la app hasta que vuelves. Para evitarlo, activa en el panel **Mantener el
ordenador despierto enchufado** (para todo el ordenador, no por proyecto): en macOS el runner mantiene `caffeinate -s`, que solo
actúa con el cargador puesto (con batería no la gasta y el panel lo dice); en Linux, `systemd-inhibit`, también con batería. La
pantalla se apaga igual, y con la tapa cerrada sin pantalla externa el Mac se duerme igual. Se suelta al apagar el runner con el
botón general. Alternativa sin el runner: *Ajustes del Sistema › Batería › Opciones › Evitar el reposo automático con el
adaptador de corriente cuando la pantalla está apagada*.

**Publicar OTA exige probarlo antes** (botón Publicar de la app, también los rollbacks): el runner compila la app en Release
con el JS incrustado, en la copia limpia que va a publicar, la abre en un simulador propio («Backcode OTA test», no toca los
tuyos) y comprueba que sigue viva 15 s. Si se cierra o no compila, no se publica. Un OTA que cierra la app al arrancar no
tiene arreglo por OTA (el móvil no llega a descargar el siguiente). Requisitos: Mac con Xcode, y que la app compile en tu
máquina (sus `.env` y ficheros de Firebase locales, como `GoogleService-Info.plist`, se copian solos). La primera vez por
proyecto tarda ~10 min (compilación nativa); después, unos minutos.
El runner encuentra `bun`, `pnpm` y Volta en sus carpetas de instalación (`~/.bun/bin`, `~/Library/pnpm`, `~/.volta/bin`)
aunque solo estén en el PATH de tu `.zshrc`: abierto desde la app de Mac o como servicio, no hereda el de tu terminal.

**Primero lo rápido.** Antes de compilar se mira si la copia a publicar tiene archivos sin commitear: si los hay, falla al
momento diciendo cuáles, y la app ofrece **Commit y publicar** (los commitea en la rama base, sin forzar, y publica ese commit;
nunca `.env`, claves ni nada que parezca un secreto). Si el script `ota:publish` del repo usa `BACKCODE_SMOKE_CLI`, la prueba
de arranque la lanza él después de sus propias comprobaciones (cambios nativos, versión…), así esos fallos tampoco esperan a la
build:
```bash
if [ -n "${BACKCODE_SMOKE_CLI:-}" ]; then node "$BACKCODE_SMOKE_CLI" . --from "${BACKCODE_SMOKE_FROM:-.}" || exit 1; fi
```
Si no lo usa, el runner hace la prueba antes de llamar al script. La prueba deja la copia como estaba (deshace lo que toca la
build y borra lo que genera, p. ej. `ios/`).

**Si falla por CocoaPods.** La prueba genera `ios/` (`expo prebuild`) e instala los pods ella misma, paso a paso: si
`pod install` falla, el error lo dice con su causa (red, `pod` que no está en el PATH del runner, locale sin UTF-8, una
dependencia que no resuelve…) en vez del «The sandbox is not in sync with the Podfile.lock» y el código 65 con que moriría
xcodebuild. Ese fallo no es del código JS: arréglalo en el Mac del runner (p. ej. `brew install cocoapods`) y vuelve a
publicar. Si lo que no compila es el código, el error trae las líneas `error:` de xcodebuild y guarda una copia del log
completo (`smoke-xcodebuild-*.log`, junto a las capturas en la carpeta de copias del runner).

**Publicar sin comprobaciones (peligroso).** Junto a Publicar, la app tiene **Publicar sin comprobaciones** (siempre pide
confirmación): se salta la prueba de arranque (la del runner y la del script, que recibe `BACKCODE_SMOKE_DONE=1`) y, si el
script `ota:publish` admite `--allow-native` (su guarda de cambios nativos), se lo pasa. Mantiene todo lo demás (checks en
verde, archivos sin commitear). Sirve también en un runner sin Xcode. Úsalo solo si sabes que el cambio es solo JS y no
puede romper el arranque: si lo rompe, solo lo arregla una build nueva. En el historial queda marcada como «sin comprobaciones».

## Cambiar la ruta del repo, la rama base o los PR
App → Proyecto → Conectar → **Configurar de nuevo** → cambia lo que quieras → "Ya tengo una llave en este ordenador" → **Copiar
configuración** → en el panel, **Pegar configuración**. Sustituye la configuración de ese proyecto sin tocar los demás y lo reinicia.

Al arrancar, el runner comprueba el repo real y se adapta (y te lo avisa en la terminal y en la app):
- Si la rama base configurada no existe (p. ej. el repo usa `master` y no `main`), usa la rama por defecto del repo.
- Si el repo no está en GitHub ni Bitbucket, o es Bitbucket sin token, sube la rama sin abrir PR.

## PRs en Bitbucket (API token)
1. Abre <https://id.atlassian.com/manage-profile/security/api-tokens> con la cuenta con la que entras en Bitbucket.
2. **Create API token with scopes** → ponle nombre y caducidad → app **Bitbucket**.
3. Permisos: `read:user:bitbucket` (imprescindible), `read:repository:bitbucket`, `write:repository:bitbucket`,
   `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` y, para crear proyectos desde la app,
   `admin:repository:bitbucket`. Copia el token (solo se muestra una vez).
4. En la guía de la app elige **"Abrir PR en Bitbucket"** y, al pegar la configuración en el panel (o en `backcode connect`),
   introduce el **email de esa cuenta de Atlassian** (no el usuario de Bitbucket) y el token.

Al conectar se **comprueba el token** contra la API de Bitbucket antes de guardarlo y, si falla, te dice por qué (email o
token incorrectos, falta un permiso o no tienes acceso al repo) y te deja reintentarlo (o seguir sin PR). Si el guardado deja de valer (caduca o lo
cambias), te pide otro y lo actualiza en todos tus proyectos de Bitbucket. El token se guarda solo en este ordenador
(`~/.backcode/config/credentials`, el de tu cuenta, y en el `.env` del proyecto). También lo puedes añadir o cambiar en
el panel, sección **Cuentas**. Lo usa el runner para abrir y mergear PRs y crear repos; Claude nunca tiene acceso a él.

## Proyectos nuevos desde una idea
Un admin de un grupo con plan Equipo puede crear en la app un proyecto que aún no existe, contándolo en un chat. Lo
crea **tu** runner (cualquiera de los tuyos que esté encendido) con **tus** credenciales:
1. Valida el nombre del repo y la cuenta, organización o workspace, y crea la carpeta dentro de tu **carpeta de proyectos**:
   la de tus ajustes en la app (solo vale dentro de tu `$HOME`, fuera de `~/.backcode` y de carpetas ocultas) o, si no
   hay, la carpeta donde ya tienes más repos conectados, o `~/Projects`. La carpeta del repo no puede existir.
2. `git init -b main`, un `README.md` y el primer commit.
3. El repo remoto: `gh repo create` en GitHub, o la API de Bitbucket con tu token (permiso `admin:repository:bitbucket`),
   y el push de `main`.
4. La configuración del proyecto (`~/.backcode/config/<proyecto>.env`), como la de `backcode connect`. El panel (o
   `backcode start`) ve el proyecto nuevo en unos segundos y arranca su runner, que ejecuta la primera tarea (montar el
   proyecto) y abre su PR en borrador.

Para que la app sepa qué ofrecer, cada runner publica en tu perfil privado (`users/{uid}/private/machine`) la carpeta de
proyectos, tu usuario de `gh` y sus organizaciones, y tus workspaces de Bitbucket, al arrancar y cada hora. Nunca tokens.


## Qué hace con cada tarea
1. La reclama (`execute → running`) y verifica que es tuya, que sigues en el grupo y que el encargo y los adjuntos no han cambiado
   desde que la aceptaste (huella).
2. Crea una copia aislada (worktree) en `~/.backcode/worktrees/<proyecto>/<tarea>` sobre su rama, partiendo de `<remoto>/<base>`.
   Tu carpeta de trabajo no se toca. Los adjuntos (capturas, PDFs…) se descargan en `.backcode-attachments/`, excluida de git.
3. Lanza Claude Code con [`instructions/AGENT.md`](instructions/AGENT.md): trabajar solo en esa rama, ejecutar los tests, preguntar
   (`ask_user`) si algo esencial es ambiguo y llamar a `open_pull_request` al terminar.
   En **modo plan** (`planFirst`), hasta que se aprueba el plan Claude solo puede leer (Read, Glob, Grep: sin editar ni ejecutar
   comandos) y entrega el plan con `propose_plan`; la tarea pasa a `waiting` con `result.planReady`. Cada comentario en el hilo
   le hace rehacerlo; al aprobarlo (`planApproved`), la misma sesión lo implementa con las herramientas de siempre.
4. Revisa el resultado (rechaza cambios en rutas protegidas y diffs con secretos), hace commit y push y abre el **PR en borrador**.
5. Marca la tarea como `done` (con el PR), `waiting` (si Claude preguntó o propuso un plan) o `failed` (con el motivo). La app muestra la actividad
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
- **En directo:** en la app, la pantalla «En directo» de la tarea muestra lo que hace Claude y deja escribirle mientras
  trabaja. El mensaje le llega en su siguiente paso, sin pararlo, y se marca como **leído** cuando lo incorpora. Si llega
  justo cuando termina, la tarea vuelve a la cola y la siguiente vuelta empieza por él. **Parar** termina el paso en curso y
  deja la tarea esperando tu mensaje.
- **Abrir en la app de Claude (Remote Control):** el runner pausa su turno y abre la misma sesión con
  `claude --resume <sesión> --remote-control` en el worktree (macOS o Linux, con Claude Code instalado y sesión iniciada
  con una cuenta Pro o Max). La app abre el enlace en la app de Claude. Allí Claude trabaja con **tus permisos normales de
  Claude Code, fuera del sandbox del runner**. La tarea sigue «Ejecutando» y su actividad se sigue viendo en Backcode. Al
  salir de la sesión o pulsar **Volver a Backcode**, el runner retoma la misma sesión en el sandbox: revisa lo hecho,
  publica los cambios (el mismo PR) o te pregunta.
  Mientras está abierta allí, la tarjeta del tablero y la ficha dicen **En la app de Claude** (no avanza sola). Si la
  terminas allí, muévela a mano (p. ej. a «PR listo»): en unos minutos el runner la suelta (sin cerrar tu sesión de Claude) y
  enlaza el PR abierto de su rama.
- **Seguir en Claude Code:** la app te da el comando (`cd ~/.backcode/worktrees/… && claude --resume <sesión>`). Ahí
  trabajas con tus permisos normales, fuera del sandbox del runner.

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
| **Build** | admins y owner | Build local con EAS (iOS y/o Android) con la versión y runtimeVersion escritas en la app, y envío a TestFlight / Internal Testing (ver abajo). |
| **Instalar en mi móvil** | cualquier miembro | Compila la app en Release con lo último de la rama base y la instala en uno de **tus** móviles emparejados con el ordenador de tu runner, por wifi o por cable (ver abajo). |

### Tu copia local se pone al día sola
Tras mergear, publicar un OTA, una build o un despliegue desde la app, y cada vez que arranca el runner, tu copia local de la
rama base se actualiza con lo que hay en el remoto (lo que se publica es siempre la rama base del remoto, nunca tu copia local), **solo si es seguro**: estás en la rama base sin cambios pendientes y es un avance limpio (fast-forward). Si estás en otra
rama, se avanza la rama base sin cambiar de rama. Si cambiaron dependencias (`package.json` o lockfile), instala con el gestor del
repo (`pnpm`/`yarn`/`bun install --frozen-lockfile` o `npm install`). Si algo no cuadra (cambios sin guardar, commits locales que
no están en el remoto), no toca nada y lo avisa en la terminal para que hagas `git pull` tú.

### Cómo publica el OTA cada proyecto
El runner lo detecta al arrancar, leyendo la rama base:
1. **Script propio**: si el `package.json` de la app tiene `ota:publish` (p. ej. un servidor **xprem** propio), ejecuta
   `<pnpm|yarn|npm> run ota:publish <rama> --yes -m "<mensaje>"` en una copia limpia de la rama base. El runner le pasa `prod` o
   `preview` y el script de cada repo los traduce a sus ramas reales de xprem (p. ej. Castellers usa `prod`/`preview` y Backcode
   `main`/`dev`). Si el script ya lleva la rama escrita (p. ej. `bash scripts/publish-update.sh prod`), no se repite; si
   lleva otra rama distinta del canal pedido, no se publica. Se copian a esa copia los `.env`/`.env.local`
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

### PR de fuera de Backcode y descartar PR
- **PR externos en el tablero**: cada 5 min el runner lista los PR abiertos del repo (con `gh` o el token de Bitbucket) que no
  vienen de una tarea (ramas que no empiezan por `backcode/`), con el estado de sus checks, y la app los enseña al pie de la
  columna «PR listo». Si el runner no puede leerlos (gh sin sesión, token caducado), lo dice a los admins.
- Un admin puede **mergearlos** (checks en verde, squash y borrar la rama) o **descartarlos** (cerrar el PR, conservando o
  borrando su rama). Lo hace **su** runner, así que solo se ofrece si el suyo está conectado y con GitHub/Bitbucket enlazado;
  si no, la app dice qué enlazar. El runner solo toca PR que estén abiertos en ese repo.
- **PR de una tarea abierto fuera del runner** (p. ej. por Claude en la app de Claude, en la rama `backcode/…`): si la tarea
  está en «PR listo» sin PR enlazado, el runner lo enlaza en esa misma pasada.
- **Descartar una tarea con PR abierto** (ficha o tablero) también cierra el PR y borra su rama y su copia de trabajo.

### Pendiente de desplegar
Arriba de la pantalla de publicar, una tarjeta con **lo que hay en la rama principal y aún no ha salido**, en pasos numerados y
en el orden correcto: primero las reglas (Firestore/Storage), luego las functions, luego el resto de despliegues (web…) y la OTA
al final, para que la app nueva no llegue antes que lo que necesita en el servidor. El runner lo calcula al arrancar, cada 3 min
y tras cada acción: compara la rama principal con el commit del último despliegue hecho desde Backcode de cada paso (qué ficheros
cubre cada uno lo saca del `--only` de Firebase del script o de su carpeta) y dice qué tareas mergeadas traen cada cambio.
- Cada paso tiene su botón (**Desplegar**) y hay **Desplegarlo todo**: los pendientes en ese orden, en una sola acción que **se
  para al primer fallo** (no publica la OTA si las reglas o las functions no han salido). Solo admins, como los despliegues.
- Un paso **sin registro** (nunca desplegado desde Backcode) no cuenta como pendiente: despliégalo una vez y desde entonces se sigue.
- En la pestaña OTA avisa si hay pasos pendientes que van antes; en la ficha de una tarea mergeada, por dónde le falta salir.
- Si la OTA trae cambios que parecen nativos (config de Expo, dependencias, `ios/`, `android/`), lo avisa: quizá toca una build.

### Instalar en mi móvil
Pestaña **Mi móvil** de la pantalla de publicar (en apps Expo, si el ordenador de tu runner tiene Xcode o adb). Es la vía más rápida
de probar en tu móvil un binario real, sin TestFlight ni tiendas, y solo llega a tu móvil:
- **Tus móviles**: cada runner mira cada 45 s qué móviles ve su ordenador (`xcrun devicectl` para iPhone; `adb`, con
  reconexión automática de los Android ya emparejados por wifi) y los guarda en `projects/{pid}/runners/{uid}/private/devices`,
  que **solo lees tú**. La app enseña cuáles están listos y, de los que no, qué les falta (no está en la misma wifi, falta el Modo
  desarrollador, falta aceptar la depuración). El botón **Instalar en …** solo aparece con un móvil listo.
- **Emparejar** (una vez, lo hace la persona): iPhone por cable, «Confiar», Modo desarrollador y «Connect via network» en Xcode;
  Android con Depuración inalámbrica › Vincular con código y `adb pair IP:PUERTO`. La pantalla y el panel (sección **Móviles**)
  lo explican.
- **Qué hace el runner** (el tuyo, en tu ordenador): copia limpia de la rama base, dependencias, `.env` y ficheros de Firebase
  locales, variables del perfil `production` de `eas.json`. iOS: primero monta en el iPhone la imagen de desarrollador de Xcode
  (solo se puede con el iPhone **desbloqueado**: espera hasta 2 min a que lo desbloquees y, si no, avisa sin compilar); después
  CocoaPods y `expo run:ios --configuration Release --device <udid> --no-install` (firma con tu equipo de Xcode, instala y abre). Android: `expo prebuild`, `./gradlew assembleRelease` y `adb install -r` (si la
  instalada es de Google Play, con otra firma, hay que desinstalarla antes). Sin checks: solo llega a tu móvil.

- **Versión de desarrollo** (en **Mi móvil**, «De desarrollo»): instala una build Debug que no lleva el JavaScript dentro,
  sino que lo carga del **servidor de desarrollo** (Metro) de tu runner, por la wifi y en un puerto propio de cada proyecto. Se
  instala una vez (y otra si cambia algo nativo). Después eliges qué código sirve: **la rama principal** (desde Mi móvil) o **una
  tarea** con «Probar en mi móvil» en su ficha (su copia de trabajo si la tiene tu runner, así ves lo que Claude va cambiando; si
  no, su rama subida). Cierras y vuelves a abrir la app y lo ves; los cambios siguientes llegan solos. Metro corre en
  `~/.backcode/worktrees/<proyecto>/_dev` (o en la copia de la tarea), sin tocar ficheros versionados (`EXPO_NO_TYPESCRIPT_SETUP`),
  y se apaga solo a las 4 h o al reiniciar el runner. El estado lo guarda en `runners/{uid}/private/dev` (solo lo lees tú).
  El runner apunta en qué móviles instaló la versión de desarrollo de cada proyecto (`~/.backcode/dev-installs.json`; una
  normal encima la quita): sin ninguno, «Probar en mi móvil» lo explica y lleva a instalarla. Al instalarla, Expo arranca su
  propio servidor y no termina: el runner la da por hecha cuando la app ya está abierta en el móvil y arranca el suyo.
  Si el runner se reinicia (p. ej. al actualizarse), vuelve a arrancar el servidor con lo que servía (`~/.backcode/dev-serving.json`).
  Sirviendo la rama principal (o la rama subida de una tarea), cada minuto mira si hay commits nuevos y se pone al día solo: un
  merge llega al móvil sin reinstalar ni pulsar nada (si cambian las dependencias, las instala y reinicia Metro).
- **Más rápida a partir de la segunda vez**: la instalación usa una sola copia por proyecto que se conserva
  (`~/.backcode/worktrees/<proyecto>/_install`, con sus dependencias, `ios/`/`android/`, Pods y la caché de Xcode): solo se mueve
  al commit nuevo y se compila lo que ha cambiado. No se acumulan copias: hay una por proyecto (y otra, `_dev`, para el servidor
  de desarrollo), y el runner borra las que lleven 14 días sin usarse.

### Builds para testers (TestFlight / Internal Testing)
En la misma pantalla de publicar, pestaña **Build** (solo admins y owner; se ofrece si el `eas.json` tiene el perfil
`production`). Es un binario nuevo, no un OTA: el admin elige iOS y/o Android y escribe la **versión** (`1.0.16`) y la
**runtimeVersion** (por defecto, la misma que la versión). El runner, en una copia limpia de la rama base y con los checks en verde:
1. Instala dependencias y comprueba con `expo config` que la app aplica la versión pedida: la recibe en `APP_VERSION` y
   `RUNTIME_VERSION`, y su `app.config.js` tiene que leerlas (ver `app/app.config.js` de Backcode). Si no, falla sin compilar.
2. Por plataforma: `eas build --local --profile production` (en tu ordenador; iOS solo en un Mac con Xcode) y
   `eas submit --path <binario>`: iOS va a TestFlight y Android al track del perfil de submit (`internal` por defecto).

Usa tu sesión de EAS y las credenciales de las tiendas que tengas en EAS (`eas credentials`); no se copia ningún `.env` local ni
se toca `ios/`/`android/`. El número de build lo gestiona EAS (`appVersionSource: remote` + `autoIncrement`).

### Despliegues del repo (monorepos: web, api, scripts…)
Pestaña **Despliegues** de la pantalla de publicar (solo admins y owner). El runner busca en todos los `package.json` del repo
(sin `node_modules`) los scripts que se llaman `backcode:deploy:<nombre>` y ofrece un botón por cada uno; el sufijo es el nombre
(`web`, `api`, `docs`…; minúsculas, números y guiones). Solo esos: un `deploy` sin su línea `backcode:` nunca aparece. Lo normal
es duplicar el que ya tenéis, sin renombrarlo:

```json
"deploy": "firebase deploy --only hosting",
"backcode:deploy:web": "npm run deploy"
```

Al pulsarlo, en una copia limpia de la rama base y con los checks en verde: instala con el gestor del repo (donde esté el
lockfile: la carpeta o la raíz del monorepo), copia tus `.env`, `.env.local`, `.env.production` y `.env.production.local`
(solo si git los ignora; de la raíz y de la carpeta) y ejecuta `<pm> run backcode:deploy:<nombre>` en esa carpeta, sin
interacción (`CI=1`, máx. 30 min). El último enlace `https://…` que imprima se muestra en la app como «Abrir». Los destinos se
detectan al arrancar: tras añadir uno, reinicia el runner.

Si el script llama a `firebase` (directamente, vía `npm run <otro>` o en un `.sh` del repo), el runner deduce sin ejecutarlo a
qué va: proyecto (`-P`/`--project`, alias de `.firebaserc` o su `default`) y canal de Hosting (`hosting:channel:deploy <canal>`
o el sitio principal con `firebase deploy`). La app lo enseña junto al botón, en la confirmación y en el historial, p. ej.
«Firebase Hosting · proyecto derbi-admin-staging · canal staging (preview)». Para un staging de Firebase basta con:

```json
"backcode:deploy:staging": "firebase hosting:channel:deploy staging -P staging --expires 7d --non-interactive"
```

(o `firebase deploy --only hosting -P <proyecto-staging>` si el staging es otro proyecto de Firebase). La sesión de Firebase es
la de tu ordenador (`firebase login`): si falla por sesión, proyecto o CLI, la app lo explica encima del error.

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

## Refinado de ideas con tu Claude Code
Si activas **Perfil → Refinado de ideas → Usar mi Claude Code**, las ideas que escribes en «Nueva idea» las prepara tu runner
(el de ese proyecto, si está conectado) en lugar del modelo de OpenAI del servidor. Claude abre una copia de la rama base **en
solo lectura** (Read, Glob y Grep; sin Bash, sin escritura y sin red), lee el código que haga falta y devuelve el mismo
encargo (título, prompt, criterios, preguntas, avisos de seguridad y modelo sugerido). Mientras trabaja, la app muestra qué está
leyendo, y la propuesta indica qué modelo la ha escrito. Usa `BACKCODE_REFINE_MODEL` (por defecto `sonnet`) y consume de tu plan
o API key. Si el runner está apagado, ocupado con otro refinado, falla o tarda más de 3 minutos, el servidor la refina con
OpenAI como siempre y la app lo indica. Solo se usa tu propio runner: las ideas de otros nunca gastan tu cuota.

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
Edita [`instructions/AGENT.md`](instructions/AGENT.md) (en una copia de git: con npm, la versión nueva lo sobrescribe). Admite estos marcadores: `{{projectName}}`, `{{worktree}}`, `{{branch}}`,
`{{baseBranch}}`, `{{remote}}`, `{{projectContext}}`, `{{claudeMd}}` y `{{language}}` (idioma de tu perfil, p. ej. `Spanish`). Si quitas reglas de seguridad no se desactivan las barreras
técnicas, pero el agente pierde contexto sobre por qué existen.

## Variables del `.env`
Las genera la app; las puedes ajustar a mano en `~/.backcode/config/<proyecto>.env` (después, reinicia ese proyecto en el panel). Ver [`.env.example`](.env.example) para todas
(límites por tarea, modelo, dominios permitidos, rutas protegidas, mapa del proyecto…).

## Desarrollo
```bash
git clone https://github.com/hernanmateo/backcode-runner.git && cd backcode-runner
npm install
npm run panel        # el panel desde esta copia (o npm run connect / npm run all / npm start -- --project <id>)
npm test
```
La app de Mac: `npm run build:mac` (en un Mac) compila los dos ejecutables de macOS, los une en uno universal dentro de
`Backcode Runner.app` y crea `Backcode-Runner.dmg`; los firma y notariza si están `MAC_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID` y
`APPLE_APP_PASSWORD` (en CI, de los secretos del repo; ver `release.yml`). Sin firma sirve para probarla en tu Mac.

Publicar (claves, pruebas y pasos en el monorepo: `docs/RUNNER-PUBLICAR.md`): `npm version minor && git push --follow-tags`. La etiqueta `vX.Y.Z` lanza el workflow `release.yml`: compila y pasa los
tests, compila los ejecutables (`npm run build:bin`, con [Bun](https://bun.sh)) para macOS y Linux (Intel y ARM), los publica en
una Release con `SHA256SUMS` e `install.sh`, y publica `backcode` en npm si el repo tiene el secreto `NPM_TOKEN`.
El ejecutable es el mismo código TypeScript con el panel, las instrucciones y el `package.json` incrustados (`src/embedded.ts`
solo se rellena en la copia de compilación).
Variables útiles para probar sin tocar tu configuración: `BACKCODE_HOME=/tmp/bc` y `BACKCODE_PANEL_PORT=47999`.

## Licencia
[Apache-2.0](LICENSE). Ver [NOTICE](NOTICE).
