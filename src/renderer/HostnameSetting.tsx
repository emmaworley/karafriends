import M from "materialize-css";
import React, { useEffect, useState } from "react";

import { HOSTNAME } from "../common/constants";
import "./global";

export default function HostnameSetting(props: {
  hostname: string;
  onChange: (name: string) => void;
}) {
  const [currentValue, setCurrentValue] = useState(props.hostname);

  useEffect(() => {
    M.AutoInit();
  }, []);

  return (
    <div className="input-field">
      <select
        defaultValue={currentValue}
        onChange={(e) => {
          setCurrentValue(e.target.value);
          props.onChange(e.target.value);
        }}
      >
        <option value="offkai.karafriends.party">
          offkai.karafriends.party
        </option>
        <option
          value={`${HOSTNAME}:${
            window.karafriends.karafriendsConfig().remoconPort
          }`}
        >
          {HOSTNAME}
        </option>
        {window.karafriends.ipAddresses().map((address) => (
          <option
            value={`${address}:${
              window.karafriends.karafriendsConfig().remoconPort
            }`}
            key={address}
          >
            {address}
          </option>
        ))}
      </select>
      <label>Hostname</label>
    </div>
  );
}
