import { useEffect, useRef, useState } from "react";
import { Monitor, X } from "lucide-react";
import type { Machine, SetupAction, SetupJob, TailscalePeers } from "../../shared/machines.ts";
import { answerMachineSetup, fetchMachineSetup, fetchTailscalePeers, startMachineSetup } from "../lib/api.ts";
import { sshOutputParts } from "../lib/sshOutput.ts";
import { BridgeUpdateProgress } from "./MachineSidebar.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";

/** the host of an SSH destination, for comparing a typed `user@host` with a tailnet address */
const hostOf = (destination: string) => destination.slice(destination.lastIndexOf("@") + 1).toLowerCase();

type PeerList = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; peers: TailscalePeers };

export function MachineDialog({ machine, machines = [], updateRemote = false, onClose, onConnected }: { machine?: Machine; machines?: Machine[]; updateRemote?: boolean; onClose(): void; onConnected(id: string): void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const destinationField = useRef<HTMLInputElement>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const [destination, setDestination] = useState(machine?.target?.destination ?? "");
  const [name, setName] = useState(machine?.name ?? "");
  const [port, setPort] = useState(String(machine?.target?.port ?? ""));
  const [key, setKey] = useState(machine?.target?.identity_file ?? "");
  const [session, setSession] = useState(machine?.target?.session ?? "");
  const [job, setJob] = useState<SetupJob | null>(null);
  const jobRef = useRef(job); jobRef.current = job;
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const finished = !!job && ["failed", "cancelled", "connected"].includes(job.phase);
  const secretAllowed = window.isSecureContext;
  const [peerList, setPeerList] = useState<PeerList>({ status: "loading" });
  const picking = !machine && !job;
  const noTailscale = peerList.status === "ready" && peerList.peers.state === "missing";
  const added = new Set(machines.flatMap((existing) => existing.target ? [hostOf(existing.target.destination)] : []));
  useEffect(() => {
    if (machine) return;
    let cancelled = false;
    fetchTailscalePeers().then((peers) => { if (!cancelled) setPeerList({ status: "ready", peers }); },
      (e) => { if (!cancelled) setPeerList({ status: "error", message: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [machine]);
  const pick = (peer: { name: string; address: string }) => {
    setDestination(peer.address); setName(peer.name); setError(null);
    connectButton.current?.focus();
  };
  const needsBridgeUpdate = job?.phase === "failed" && job.action_required === "update_bridge";

  // closing cancels a job that still waits on this dialog (a question, an approval); an
  // approved install keeps going on the server and shows in the sidebar
  // React's autoFocus runs at mount, while the dialog is still closed; showModal() then moves focus
  // to the first focusable element (Close), so the field is focused again once the dialog is open
  useEffect(() => { dialog.current?.showModal(); destinationField.current?.focus(); return () => { const current = jobRef.current; if (current && !["connected", "failed", "cancelled", "installing", "starting"].includes(current.phase)) void answerMachineSetup(current.id, { action: "cancel" }).catch(() => {}); }; }, []);
  const running = !!job && ["installing", "starting"].includes(job.phase);
  useEffect(() => {
    if (!job || finished) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try { const next = await fetchMachineSetup(job.id); if (!cancelled) { setJob(next); setError(null); } }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
      if (!cancelled) timer = window.setTimeout(poll, 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job?.id, finished]);
  useEffect(() => setSecret(""), [job?.challenge?.id]);

  const begin = async () => {
    if (pending) return;
    setError(null); setPending(true);
    try { setJob(await startMachineSetup({ destination: destination.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...(port ? { port: Number(port) } : {}), ...(key.trim() ? { identity_file: key.trim() } : {}), ...(session.trim() ? { session: session.trim() } : {}), ...(machine ? { machine_id: machine.id } : {}), ...(needsBridgeUpdate || updateRemote ? { update_remote: true } : {}) })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  const act = async (action: SetupAction) => {
    if (!job || pending) return;
    setPending(true); setError(null); setSecret("");
    try { setJob(await answerMachineSetup(job.id, action)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  return <dialog ref={dialog} className="modal machine-dialog" aria-labelledby="machine-dialog-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header className="modal-header"><h2 id="machine-dialog-title" className="modal-title"><Monitor size={18} /> {t(updateRemote ? "Update remote bridge" : machine ? "Reconnect PC" : "Add PC")}</h2><button className="icon-button" aria-label={t("Close PC setup")} onClick={onClose}><X /></button></header>
    <div className="modal-body">
      {(!job || finished && job.phase !== "connected") && <form id="machine-connect-form" onSubmit={(e) => { e.preventDefault(); void begin(); }}>
        {picking && !noTailscale ? <section className="tailscale-picker" aria-label={t("Your Tailscale PCs")}>
          <h3 className="field-label">{t("Your Tailscale PCs")}</h3>
          {peerList.status === "loading" && <p className="field-hint" role="status">{t("Loading Tailscale PCs…")}</p>}
          {peerList.status === "error" && <p className="machine-error" role="alert">{peerList.message}</p>}
          {peerList.status === "ready" && peerList.peers.state === "stopped" && <p className="field-hint">{t("Tailscale is not running on this PC")}</p>}
          {peerList.status === "ready" && peerList.peers.state === "running" && (peerList.peers.peers.length === 0
            ? <p className="field-hint">{t("No other PCs on your Tailscale")}</p>
            : <ul className="tailscale-peers">{peerList.peers.peers.map((peer) => {
              const isAdded = added.has(hostOf(peer.address));
              return <li key={peer.address}><button type="button" className="tailscale-peer" disabled={!peer.online || isAdded} aria-pressed={destination === peer.address} onClick={() => pick(peer)}>
                <span className="tailscale-peer-name">{peer.name}</span>
                <span className="tailscale-peer-meta">{peer.os}</span>
                <span className="tailscale-peer-state" data-online={peer.online || undefined}>{t(isAdded ? "Added" : peer.online ? "Online" : "Offline")}</span>
              </button></li>;
            })}</ul>)}
        </section> : null}
        <label className="field"><span className="field-label">{t("SSH alias or user@address")}</span><input ref={destinationField} autoFocus className="input" required autoComplete="off" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="devbox or user@192.168.1.20" /></label>
        <label className="field"><span className="field-label">{t("PC name")}</span><input className="input" maxLength={100} value={name} placeholder={destination || t("Filled from the SSH address")} onChange={(e) => setName(e.target.value)} /></label>
        <details><summary>{t("Advanced settings")}</summary><div className="machine-advanced">
          <label className="field"><span className="field-label">{t("SSH port")}</span><input className="input" type="number" min="1" max="65535" placeholder={t("From SSH config (default 22)")} value={port} onChange={(e) => setPort(e.target.value)} /></label>
          <label className="field"><span className="field-label">{t("Private key path on this web server")}</span><input className="input" value={key} placeholder="~/.ssh/id_ed25519" onChange={(e) => setKey(e.target.value)} /></label>
          <label className="field"><span className="field-label">{t("herdr session name")}</span><input className="input" value={session} placeholder={t("Default session")} onChange={(e) => setSession(e.target.value)} /></label>
        </div></details>
        {!machine && <p className="field-hint">{t("Tailscale SSH may show a sign-in link while connecting; open it in your browser to continue.")}</p>}
        <p className="field-hint">{t("Uses the web server account’s SSH config and ssh-agent. Agent CLI tools and logins use the environment on the target PC.")}</p>
      </form>}
      {job && <div className="machine-progress" role="status">{running && job.progress ? <BridgeUpdateProgress update={{ job_id: job.id, step: job.step, progress: job.progress }} /> : <strong>{job.step}</strong>}{job.error && <p>{job.error}</p>}{job.ssh_output && <pre className="machine-ssh-output" aria-label={t("SSH output")}>{sshOutputParts(job.ssh_output).map((part, i) => part.type === "link" ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.value}</a> : part.value)}</pre>}</div>}
      {needsBridgeUpdate && <p className="field-hint">{t("This PC runs a bridge from a different version of herdr web ui. Update it to reconnect; herdr sessions keep running.")}</p>}
      {running && <p className="field-hint">{t("You can close this; the install keeps going and the sidebar shows it.")}</p>}
      {job?.phase === "approval" && <><ul className="machine-install-list">{job.installations.map((item) => <li key={item}>{item}</li>)}</ul><p className="field-hint">{t("Installs into your home directory. Existing herdr sessions keep running.")}</p></>}
      {job?.challenge && <div className="machine-challenge"><pre>{job.challenge.prompt}</pre>{job.challenge.kind === "host_key" ? <p className="field-hint">{t("Compare this fingerprint with the PC before accepting it.")}</p> : <form onSubmit={(e) => { e.preventDefault(); void act({ action: "answer", challenge_id: job.challenge!.id, answer: secret }); }}>
        <label className="field"><span className="field-label">{t("Password or key passphrase")}</span><input autoFocus className="input" type="password" autoComplete="off" value={secret} disabled={!secretAllowed || pending} onChange={(e) => setSecret(e.target.value)} /></label>
        {!secretAllowed && <p className="field-hint">{t("Open this app over HTTPS or localhost to enter a password.")}</p>}
        <button type="submit" className="btn btn-primary" disabled={!secretAllowed || pending || !secret}>{t("Continue")}</button>
      </form>}</div>}
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer">
      {job && !finished && <button className="btn" disabled={pending} onClick={() => void act({ action: "cancel" })}>{t(running ? "Cancel install" : "Cancel connection")}</button>}
      {running && <button className="btn btn-primary" onClick={onClose}>{t("Continue in background")}</button>}
      {job?.challenge?.kind === "host_key" && <><button className="btn" disabled={pending} onClick={() => void act({ action: "answer", challenge_id: job.challenge!.id, answer: "no" })}>{t("Reject")}</button><button className="btn btn-primary" disabled={pending} onClick={() => void act({ action: "answer", challenge_id: job.challenge!.id, answer: "yes" })}>{t("Trust fingerprint")}</button></>}
      {job?.phase === "approval" && <button className="btn btn-primary" disabled={pending} onClick={() => void act({ action: "approve" })}>{t("Install and connect")}</button>}
      {job?.phase === "connected" ? <button className="btn btn-primary" onClick={() => onConnected(job.machine_id)}>{t("Open PC")}</button> : (!job || finished) && <button ref={connectButton} className="btn btn-primary" form="machine-connect-form" type="submit" disabled={pending}>{t(pending ? "Connecting…" : needsBridgeUpdate ? "Update bridge and connect" : job ? "Retry connection" : "Connect")}</button>}
    </footer>
  </dialog>;
}
