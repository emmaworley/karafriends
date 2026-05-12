import M from "materialize-css";
import React, { useEffect } from "react";

import { BGM_TRACKS } from "./bgmTracks";
import "./global";

interface Props {
  selected: string | null;
  onChange: (filename: string | null) => void;
}

export default function BackgroundMusicSetting({ selected, onChange }: Props) {
  useEffect(() => {
    M.AutoInit();
  }, []);

  return (
    <div className="input-field">
      <select
        value={selected ?? ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : e.target.value)
        }
      >
        <option value="">None</option>
        {BGM_TRACKS.map((t) => (
          <option key={t.filename} value={t.filename}>
            {t.label}
          </option>
        ))}
      </select>
      <label>Background Music</label>
    </div>
  );
}
