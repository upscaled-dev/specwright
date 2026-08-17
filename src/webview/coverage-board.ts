import { installRouter } from "./client/router";
import { installShell } from "./client/shell";
import { installBoard } from "./client/board";
import { installLink } from "./client/link";
import { installPublish } from "./client/publish";

installRouter();
installShell();
installBoard();
installPublish();
installLink();
