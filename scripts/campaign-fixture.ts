import assert from "node:assert/strict";
import { Player } from "../src/game/player.js";

// API-free scripted PLAYER gameplay, not an agent hint or a completion shortcut.
// All target IPs/accounts below come from this new campaign's own mail/terminal.
export async function campaignFixture(player: Player): Promise<void> {
  const screen = () => player.screen() as Promise<any>;
  const cmd = async (value: string) => {
    const result = (await player.cmd(value)) as any;
    console.log("CAMPAIGN COMMAND:", JSON.stringify(result));
    // rm is a background command with a native dot animation, not an exe in
    // ps. A quiet terminal does not imply the deletion has committed yet.
    if (value.startsWith("rm ")) await player.wait(value === "rm *" ? 12 : 4);
    if (value.startsWith("scp ")) await player.wait(2);
    return result;
  };
  const until = async (
    label: string,
    predicate: (view: any) => boolean,
    seconds = 40,
  ) => {
    const end = Date.now() + seconds * 1000;
    do {
      const view = await player.wait(0.5);
      if (predicate(view)) return;
    } while (Date.now() < end);
    throw new Error(`Campaign smoke timed out: ${label}`);
  };
  const idle = () =>
    until("program completion", (s) =>
      s.processes.exes.every((p: any) => p.type === "ShellExe"),
    );
  const readMail = () => player.mail("read", 0) as Promise<any>;
  const reply = async () => {
    const result = (await player.reply(0, "complete")) as any;
    assert.equal(
      result.completed,
      true,
      JSON.stringify(result) + " " + JSON.stringify(await screen()),
    );
    await player.wait(0.5);
    return readMail();
  };
  const links = (mail: any) =>
    Array.from(
      mail.body.matchAll(/link#%#([^#\r\n]+)#%#([\d.]+)/g),
      (m: any) => ({ name: m[1], ip: m[2] }),
    );
  const account = (mail: any) => {
    const m = mail.body.match(
      /account#%#([^#\r\n]+)#%#([\d.]+)#%#([^#\r\n]+)#%#([^#\r\n]+)/,
    );
    assert.ok(m, "Expected account attached to the player's mail.");
    return { ip: m[2], username: m[3], password: m[4] };
  };
  const login = async (credentials: ReturnType<typeof account>) => {
    await cmd("connect " + credentials.ip);
    await cmd("login");
    await player.input(credentials.username);
    await until("password prompt", (s) => /Password/i.test(s.prompt), 5);
    await player.input(credentials.password);
    await until("login finished", (s) => !s.awaitingInput, 5);
  };
  const hack = async (ip: string, ssh = true, proxy = false, ftp = false) => {
    await cmd("connect " + ip);
    if (proxy) {
      await player.shell("overload");
      await until("proxy overload", (s) => !s.proxy?.proxyActive);
    }
    if (ssh) {
      await cmd("SSHCrack 22");
      await idle();
    }
    if (ftp) {
      await cmd("FTPBounce 21");
      await idle();
    }
    await cmd("porthack");
    await idle();
    const ls = await cmd("ls");
    assert.ok(
      !ls.lines.some((l: string) => /Insufficient Privileges/.test(l)),
      "Native hack did not grant admin.",
    );
  };

  console.log(
    "CAMPAIGN: first contact through ordinary mail and terminal gameplay.",
  );
  const localIP = (await screen()).thisComputerIP;
  await readMail();
  await cmd("connect " + localIP);
  await cmd("cd bin");
  await cmd("rm SecurityTracer.exe");
  let mail = await reply();
  const viper = links(mail)[0].ip;
  await hack(viper, false);
  await cmd("cd bin");
  await cmd("scp SSHcrack.exe");
  await idle();
  mail = await reply();
  const bitPC = links(mail)[0].ip;
  await hack(bitPC);
  mail = await reply();
  const logsPC = links(mail)[0].ip;
  await hack(logsPC);
  await cmd("cd log");
  await cmd("rm *");
  mail = await reply();
  const entryLinks = links(mail);
  assert.equal(entryLinks.length, 2);
  const archiveIP = entryLinks[0].ip;
  const testIP = entryLinks[1].ip;
  for (const ip of [logsPC, bitPC, viper]) {
    await cmd("connect " + ip);
    await cmd("shell");
  }
  await hack(testIP, true, true);
  await cmd("cd home");
  await cmd("cat Entropy_Induction_Test");
  await cmd("scp Entropy_Induction_Test");
  await player.wait(1);
  const invitationEnd = Date.now() + 20000;
  do {
    mail = await readMail();
    if (/Entropy/.test(mail.sender)) break;
    await player.wait(1);
  } while (Date.now() < invitationEnd);
  assert.match(mail.sender, /Entropy/);
  console.log(
    "CAMPAIGN: Entropy admission; public educational articles are readable without admin.",
  );
  const newsIP = links(mail)[0].ip;
  await cmd("connect " + archiveIP);
  const articles = (await player.hub("list")) as any;
  const article = articles.hubs[0].missions[0];
  assert.equal(article.kind, "article");
  assert.equal(article.canAccept, false);
  const lesson = (await player.hub("read", article.id)) as any;
  assert.ok(lesson.body.length > 20);
  await assert.rejects(() => player.hub("accept", article.id), /article board/);
  await hack(newsIP, true, true);
  await cmd("cd MsgBoard");
  await cmd("cd listings");
  await cmd("rm Entropy_Group_engaged_in_malicious_Hacking?");
  await cmd("rm Suspicions_arise_over_Entropy");
  await cmd("connect " + newsIP);
  await cmd("cd MsgBoard");
  await cmd("rm config.sys");
  await player.wait(1);
  mail = await reply();
  await login(account(mail));
  await cmd("cd home");
  await cmd("cat Mantra.txt");
  await cmd("connect " + account(mail).ip);
  await cmd("cd bin");
  await cmd("scp FTPBounce.exe");
  await idle();
  mail = await reply();
  const boardAccount = account(mail);
  console.log(
    "CAMPAIGN: Entropy private task board; login and contract acceptance regression.",
  );
  await cmd("connect " + boardAccount.ip);
  await assert.rejects(() => player.hub("list"), /Log in/);
  await login(boardAccount);
  const listings = (await player.hub("list")) as any;
  const pointClicker = listings.hubs[0].missions.find(
    (m: any) => m.title === "Point Clicker",
  );
  assert.ok(pointClicker, "Entropy contract not listed.");
  assert.equal(pointClicker.kind, "contract");
  assert.equal(pointClicker.canAccept, true);
  await assert.rejects(
    () => player.hub("accept", "listing:9999"),
    /numeric listing ID/,
  );
  await assert.rejects(
    () => player.hub("accept", "listing:Point_Clicker"),
    /numeric listing ID/,
  );
  const posting = (await player.hub("read", pointClicker.id)) as any;
  assert.ok(posting.body.length > 20);
  for (const key of [
    "goals",
    "reloadGoalsSourceFile",
    "email",
    "flags",
    "password",
  ])
    assert.equal(key in posting, false);
  const accepted = (await player.hub("accept", pointClicker.id)) as any;
  assert.equal(accepted.ok, true);
  const remaining = (await player.hub("list")) as any;
  assert.equal(
    remaining.hubs[0].missions.length,
    listings.hubs[0].missions.length - 1,
  );
  assert.ok(
    remaining.hubs[0].missions.every(
      (m: any) => m.title !== "Point Clicker" && !m.canAccept,
    ),
  );
  await assert.rejects(
    () => player.hub("accept", remaining.hubs[0].missions[0].id),
    /already active/,
  );
  mail = await readMail();
  assert.ok(
    links(mail).length > 0,
    "Native Accept failed to deliver task mail/link.",
  );
  assert.match(mail.subject, /Point.?Clicker/i);
  // Complete the actual first contract via its newly delivered target/link.
  // Discover the requested file from the target's normal directory listing.
  console.log(
    "CAMPAIGN: contract accepted, real mail received; completing Point Clicker.",
  );
  await hack(links(mail)[0].ip, true, false, true);
  const root = await cmd("ls");
  assert.ok(root.lines.includes(":PointClicker"));
  await cmd("cd PointClicker");
  await cmd("cd Saves");
  const saves = await cmd("ls");
  const save = saves.lines.find(
    (l: string) => l.endsWith(".pcsav") && mail.body.includes(l.slice(0, -6)),
  );
  assert.ok(
    save,
    "The client's named Point Clicker save was not visible in the save directory.",
  );
  await cmd("rm " + save.trim());
  assert.equal(((await player.reply(0, "complete")) as any).completed, true);
  await player.shell("exit");
  await until("shell shutdown", (s) => s.shells.count === 0);
  console.log(
    "PASS CAMPAIGN: tutorial → Entropy → list/read/accept → native task email → actual Point Clicker completion; no mission/flag/debug API used.",
  );
}
