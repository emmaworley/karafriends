import M from "materialize-css";
import React, { useEffect, useState } from "react";

import { HOSTNAME } from "../common/constants";
import "./global";

export default function HostnameSetting(props: {
  hostname: string;
  onChange: (name: string) => void;
}) {
  const hostnameToValue = new Map([
    ["offkai.karafriends.party", "offkai.karafriends.party"],
    [
      HOSTNAME,
      `${HOSTNAME}:${window.karafriends.karafriendsConfig().remoconPort}`,
    ],
    ...window.karafriends
      .ipAddresses()
      .map((address) => [
        address,
        `${address}:${window.karafriends.karafriendsConfig().remoconPort}`,
      ]),
  ]);

  const [currentValue, setCurrentValue] = useState(
    hostnameToValue.get(props.hostname),
  );

  useEffect(() => {
    M.AutoInit();
  }, []);

  return (
    <div className="input-field">
      <select
        value={currentValue}
        onChange={(e) => {
          setCurrentValue(e.target.value);
          props.onChange(e.target.value);
        }}
      >
        {Array.from(hostnameToValue).map(([key, value]) => (
          <option key={value} value={value}>
            {key}
          </option>
        ))}
      </select>
      <label>Hostname</label>
    </div>
  );
}
