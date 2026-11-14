import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mimeTypes = {
  js: 'application/javascript', png: 'image/png', jpg: 'image/jpeg',
  webp: 'image/webp', ttf: 'font/ttf',
};

async function packagePreview(app, exportDir, siteDir, siteOrigin, manifestOrigin, sdkVersion = '54.0.0') {
  if (!['customer', 'restaurant'].includes(app)) throw new Error('Choose customer or restaurant');
  if (!/^5[478]\.0\.0$/.test(sdkVersion)) throw new Error('Use a supported Expo Go SDK version');
  const origin = new URL(siteOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password) throw new Error('Use the public HTTPS app origin');
  const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
  const { expo } = await readJSON(new URL(`../apps/${app}/app.json`, import.meta.url));
  const { fileMetadata: { ios } } = await readJSON(path.join(exportDir, 'metadata.json'));
  const dest = path.join(siteDir, 'ios-preview');
  await mkdir(dest, { recursive: true });

  async function addAsset(file, ext) {
    if (!Object.hasOwn(mimeTypes, ext)) throw new Error(`Unexpected asset extension: ${ext}`);
    const data = await readFile(path.join(exportDir, file.replaceAll('\\', '/')));
    if (ext === 'js') {
      const source = data.toString('utf8');
      if (!source.includes('https://cdhymxldxmngiktaqivg.supabase.co')
        || !source.includes('sb_publishable_') || /sb_secret_[\w-]{12,}/.test(source)) {
        throw new Error('The export must use the cloud Supabase URL and publishable key');
      }
    }
    const key = createHash('md5').update(data).digest('hex');
    const filename = `${key}.${ext}`;
    await writeFile(path.join(dest, filename), data);
    return {
      key, hash: createHash('sha256').update(data).digest('base64url'), fileExtension: `.${ext}`,
      contentType: mimeTypes[ext], url: new URL(`/ios-preview/${filename}`, origin).href,
    };
  }

  const assetsByPath = new Map(ios.assets.map(asset => [asset.path, asset]));
  const assets = await Promise.all(Array.from(assetsByPath.values(), ({ path: file, ext }) => addAsset(file, ext)));
  const launchAsset = await addAsset(ios.bundle, 'js');
  const id = randomUUID();
  const manifest = {
    id, createdAt: new Date().toISOString(), runtimeVersion: `exposdk:${sdkVersion}`, launchAsset, assets, metadata: {},
    extra: { scopeKey: expo.slug, expoClient: { ...expo, sdkVersion } },
  };
  await writeFile(path.join(dest, sdkVersion === '54.0.0' ? 'manifest.json' : `manifest-${sdkVersion.split('.')[0]}.json`), JSON.stringify(manifest));

  const manifestPath = app === 'customer' ? '/customer/ios-preview/menu/manifest.json' : '/restaurant/ios-preview/manifest.json';
  const manifestUrl = new URL(manifestPath, manifestOrigin);
  if (manifestUrl.protocol !== 'https:' || manifestUrl.username || manifestUrl.password) {
    throw new Error('Use the HTTPS Expo Updates manifest server origin');
  }
  const deepLink = `exps://${manifestUrl.host}${manifestUrl.pathname}`;
  const appStore = 'https://apps.apple.com/us/app/expo-go/id982107779';
  await writeFile(path.join(dest, 'index.html'), `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${expo.name} iPhone demo</title>
<style>
body{margin:0;background:#FAF6F3;color:#271D19;font:17px/1.5 system-ui}
main{max-width:29rem;margin:auto;padding:3rem 1.25rem}
h1{color:#5D100A;line-height:1.15}
a{color:#5D100A}
.launch{display:block;border-radius:1rem;background:#5D100A;color:white;padding:.8rem 1rem;text-align:center;text-decoration:none;font-weight:650}
</style>
<main>
<h1>${expo.name} iPhone demo</h1>
<p>Install <a href="${appStore}">Expo Go from the App Store</a>, then open Cena with the button below.</p>
<p><a class="launch" href="${deepLink}">Open in Expo Go</a></p>
<p>${app === 'customer' ? 'The Cal Poly demo opens directly to Home.' : 'Use your restaurant demo login after the app opens.'}</p>
</main>
</html>`);
  console.log(`${app}: ${assets.length} assets and iOS JavaScript bundle packaged at ${deepLink}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packagePreview(...process.argv.slice(2));
}
