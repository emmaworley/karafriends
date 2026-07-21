import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import path from "path";
import { parse, stringify } from "yaml";

export interface KarafriendsConfig {
  // Whether to use the low bitrate URLs for DAM songs
  useLowBitrateUrl: boolean;
  // Whether to download DAM songs locally instead of streaming them
  paxSongQueueLimit: number;
  // Which port to connect to the development server on
  devPort: number;
  // Which port to listen on for the remocon server
  remoconPort: number;
  // DAM username for DAM creds
  damUsername: string;
  // DAM password for DAM creds
  damPassword: string;
  // Joysound email for joysound creds
  joysoundEmail: string;
  // Joysound password for joysound creds
  joysoundPassword: string;
  // List of admins by nickname
  adminNicks: string[];
  // List of admins by deviceId
  adminDeviceIds: string[];
  // Whether to enable supervised mode
  supervisedMode: boolean;
  // Whether to use a HTTP proxy (for outgoing connections)
  proxyEnable: boolean;
  // hostname or address of the HTTP proxy to use
  proxyHost: string;
  // port of the HTTP proxy to use
  proxyPort: number;
  // HTTP Basic username of the HTTP proxy to use
  proxyUser: string;
  // HTTP Basic password of the HTTP proxy to use
  proxyPass: string;
}

const DEFAULT_CONFIG: KarafriendsConfig = {
  useLowBitrateUrl: false,
  paxSongQueueLimit: 1,
  devPort: 3000,
  remoconPort: 8080,
  damUsername: "YOUR_USERNAME_HERE",
  damPassword: "YOUR_PASSWORD_HERE",
  joysoundEmail: "YOUR_EMAIL_HERE",
  joysoundPassword: "YOUR_PASSWORD_HERE",
  adminNicks: [],
  adminDeviceIds: [],
  supervisedMode: false,
  proxyEnable: false,
  proxyHost: "PROXY_HOST_HERE",
  proxyPort: 1234,
  proxyUser: "PROXY_USER_HERE",
  proxyPass: "PROXY_PASS_HERE",
};

function applyEnvironmentOverrides(config: KarafriendsConfig) {
  if (process.env.KARAFRIENDS_DEV_PORT)
    config.devPort = parseInt(process.env.KARAFRIENDS_DEV_PORT, 10);
  if (process.env.KARAFRIENDS_REMOCON_PORT)
    config.remoconPort = parseInt(process.env.KARAFRIENDS_REMOCON_PORT, 10);
  return config;
}

function getConfig(): KarafriendsConfig {
  // Refer to https://www.electronjs.org/docs/latest/api/app#appgetpathname
  // for where the config file should be placed. On Windows, it should be %APPDATA%/karafriends/config.yaml
  let config = DEFAULT_CONFIG;

  const configFilepath: string = path.join(
    app.getPath("userData"),
    "config.yaml",
  );

  console.log(`Checking ${configFilepath} for configs`);

  if (fs.existsSync(configFilepath)) {
    console.log(`Configs found. Loading them up.`);
    try {
      const localConfig: KarafriendsConfig = parse(
        fs.readFileSync(configFilepath, { encoding: "utf8", flag: "r" }),
      );
      config = { ...DEFAULT_CONFIG, ...localConfig };
    } catch (err) {
      // config.yaml is hand-edited by the user (for DAM/Joysound credentials),
      // so a YAML typo must not crash the app on startup. Fall back to defaults
      // for this session and, crucially, return before the write-back below so
      // the user's (fixable) config -- and their credentials -- are preserved.
      console.error(
        `Failed to parse ${configFilepath}; using defaults for this session. ` +
          "Fix the YAML and relaunch to restore your settings:",
        err,
      );
      return applyEnvironmentOverrides({ ...DEFAULT_CONFIG });
    }
  } else {
    console.log("No local configs found. Using default.");
  }

  // write back defaults (persists any newly-added config fields); best-effort
  // so an unwritable userData directory doesn't crash startup.
  try {
    fs.mkdirSync(path.dirname(configFilepath), { recursive: true });
    fs.writeFileSync(configFilepath, stringify(config));
  } catch (err) {
    console.error(`Failed to write config to ${configFilepath}:`, err);
  }

  return applyEnvironmentOverrides(config);
}

const karafriendsConfig: KarafriendsConfig = getConfig();

export default karafriendsConfig;
