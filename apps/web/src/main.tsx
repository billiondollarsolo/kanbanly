import { createRoot } from "react-dom/client";
import { BoardApp } from "./Board.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root missing");
}
createRoot(root).render(<BoardApp />);
