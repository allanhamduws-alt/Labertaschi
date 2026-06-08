const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  
  if (electronPlatformName !== 'darwin') {
    return;
  }

  // Akzeptiere beide gängigen ENV-Namens-Konventionen (der Release-Workflow setzt
  // APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID; lokale Setups oft APPLE_ID_PASSWORD / TEAM_ID).
  const appleIdPassword = process.env.APPLE_ID_PASSWORD || process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.TEAM_ID || process.env.APPLE_TEAM_ID;

  // Skip notarization if credentials are not set
  if (!process.env.APPLE_ID || !appleIdPassword || !teamId) {
    console.log('Skipping notarization: APPLE_ID, App-spezifisches Passwort oder Team-ID nicht gesetzt');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);

  try {
    await notarize({
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword,
      teamId,
    });
    console.log('Notarization complete!');
  } catch (error) {
    console.error('Notarization failed:', error);
    throw error;
  }
};
