import { fileURLToPath } from "url";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import { default as nativeAudioUrl } from "url:../../native/index.node";
const nativeAudio = require(fileURLToPath(nativeAudioUrl)); // tslint:disable-line:no-var-requires

import { contextBridge, ipcRenderer } from "electron"; // tslint:disable-line:no-implicit-dependencies
import { memoize } from "lodash";

import { KarafriendsConfig } from "../common/config";
import ipAddresses from "../common/ipAddresses";

let inputDeviceCount = 0;
const inputDevices: { [deviceId: number]: any } = {};

let karafriendsConfig: KarafriendsConfig | null = null;

contextBridge.exposeInMainWorld("karafriends", {
  ipAddresses,
  karafriendsConfig: () => {
    if (karafriendsConfig === null) {
      console.log("Making sync request for configs");
      karafriendsConfig = ipcRenderer.sendSync("config");
    }

    return karafriendsConfig;
  },
  nativeAudio: {
    // Repeatedly asking CPAL for input devices seems to cause unexpected
    // breakages, like the default output device being released. Let's avoid
    // that.
    inputDevices: memoize(nativeAudio.inputDevices),
    outputDevices: nativeAudio.outputDevices,
    inputDevice_new(name: string, channelSelection: number) {
      console.debug(
        `preload: creating input device ${inputDeviceCount}: ${name}`,
      );
      inputDevices[inputDeviceCount++] = nativeAudio.inputDevice_new(
        name,
        channelSelection,
      );
      return inputDeviceCount - 1;
    },
    inputDevice_delete(deviceId: number) {
      console.debug(`preload: deleting input device ${deviceId}`);
      delete inputDevices[deviceId];
    },
    inputDevice_getPitch(deviceId: number) {
      return nativeAudio.inputDevice_getPitch(inputDevices[deviceId]);
    },
    inputDevice_stop(deviceId: number) {
      return nativeAudio.inputDevice_stop(inputDevices[deviceId]);
    },
  },
});
