import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 640, margin: "0 auto" }}>
          <h2 style={{ color: "#b91c1c" }}>Ops, algo quebrou ao carregar o app</h2>
          <p>Envie esta mensagem para o suporte/desenvolvedor:</p>
          <pre style={{ background: "#f1f5f9", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap" }}>
            {String(this.state.err?.stack || this.state.err)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
