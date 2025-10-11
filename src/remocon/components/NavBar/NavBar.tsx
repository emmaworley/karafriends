import React from "react";
// tslint:disable-next-line:no-submodule-imports
import { FaHistory, FaHome } from "react-icons/fa";
import { Link } from "react-router";
// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import icon from "url:../../images/icon.png";

import * as styles from "./NavBar.module.scss";

const NavBar = () => {
  return (
    <div className={styles.navBar}>
      <Link to="/">
        <FaHome />
      </Link>
      <img height={40} src={icon} alt="空" />
      <Link to="/history">
        <FaHistory />
      </Link>
    </div>
  );
};

export default NavBar;
