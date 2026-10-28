// Dónde conseguir la app de Backcode. El panel enseña los que tengan dirección (null = aún no publicado).
// Cuando salgan en las tiendas:
//   ios:     https://apps.apple.com/app/id<ascAppId>   (ascAppId está en app/eas.json del monorepo)
//   android: https://play.google.com/store/apps/details?id=com.brothapps.backcode
export const APP_LINKS: { ios: string | null; android: string | null; web: string | null } = {
  ios: null,
  android: null,
  web: "https://backcode-626c6.web.app",
};
