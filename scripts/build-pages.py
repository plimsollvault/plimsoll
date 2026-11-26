"""Builds web/docs.html, web/terms.html and web/privacy.html from one shared shell,
and keeps the nav and footer on web/index.html in step with them.
Run: python scripts/build-pages.py
"""
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
dep = json.loads((ROOT / "deployments" / "robinhood.json").read_text())
EXPLORER = "https://robinhoodchain.blockscout.com"
X_URL = "https://x.com/plimsollvault"
GH_URL = "https://github.com/plimsollvault/plimsoll"
UPDATED = "26 November 2026"

X_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.3l7.3-8.3L1 2h6.4l4.4 5.9L18.9 2Zm-1.1 18.1h1.7L6.3 3.8H4.5l13.3 16.3Z"/></svg>'
GH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 1.5a10.5 10.5 0 0 0-3.3 20.5c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.1 3.1.8.1-.7.4-1.1.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.4.1-2.8 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.3 0c2-1.4 2.9-1.1 2.9-1.1.6 1.4.2 2.5.1 2.8.7.8 1.1 1.7 1.1 2.8 0 4-2.5 4.9-4.8 5.2.4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5Z"/></svg>'

def addr(a, label=None):
    return f'<a class="addr" href="{EXPLORER}/address/{a}" rel="noopener" target="_blank">{label or a}</a>'

NAV_LINKS = '<a href="/#flows">How it works</a><a href="/#logbook">Logbook</a><a href="/docs">Docs</a>'
NAV_SOCIAL = f'<a class="icon-link" href="{X_URL}" rel="noopener" target="_blank" aria-label="Plimsoll on X">{X_ICON}</a>'
FOOTER = f'''<footer><div class="wrap foot">
  <span>Plimsoll runs on Robinhood Chain (4663). Not an offer or investment advice. Stock tokens are issued by Robinhood, not by Plimsoll.</span>
  <nav class="foot-links" aria-label="Footer"><a href="/docs">Docs</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="{X_URL}" rel="noopener" target="_blank">{X_ICON} X</a><a href="{GH_URL}" rel="noopener" target="_blank">{GH_ICON} GitHub</a><a href="{EXPLORER}/address/{dep["vault"]}" rel="noopener" target="_blank">Vault contract</a><span>© 2026 Plimsoll</span></nav>
</div></footer>'''

def shell(slug, title, description, note, h1, body, toc):
    toc_html = "".join(f'<a href="#{i}">{t}</a>' for i, t in toc)
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="https://plimsollvault.com/{slug}">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#e6f0ef">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Plimsoll">
<meta property="og:url" content="https://plimsollvault.com/{slug}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="https://plimsollvault.com/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@plimsollvault">
<meta name="twitter:image" content="https://plimsollvault.com/og-image.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Spectral:ital,wght@1,400;1,500&family=DM+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<div class="edge l" aria-hidden="true"></div><div class="edge r" aria-hidden="true"></div>
<header class="nav"><div class="wrap">
  <a class="brand" href="/" aria-label="Plimsoll home"><svg viewBox="0 0 17 30" aria-hidden="true"><path fill="#12181b" d="M8.5 0 17 12H0zM8.5 30 0 18h17z"/></svg>Plimsoll</a>
  <nav class="links" aria-label="Sections">{NAV_LINKS}</nav>
  <div class="inrow" style="flex-wrap:nowrap">{NAV_SOCIAL}<a class="btn small primary" href="/console">Open console</a></div>
</div></header>
<main class="doc-page">
  <div class="wrap">
    <header class="doc-head"><p class="note">{note}</p><h1>{h1}</h1><p class="pos">Last updated {UPDATED}</p></header>
    <div class="doc-grid">
      <nav class="toc" aria-label="On this page">{toc_html}</nav>
      <article class="doc">{body}</article>
    </div>
  </div>
</main>
{FOOTER}
</body>
</html>
'''

# ------------------------------------------------------------------ docs
assets = [
    ("AAPL", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", "Uniswap v4, 0.30%"),
    ("NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "Uniswap v3, 0.05%"),
    ("MSFT", "0xe93237C50D904957Cf27E7B1133b510C669c2e74", "Uniswap v4, 0.30%"),
    ("TSLA", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", "Uniswap v3, 0.30%"),
    ("AMZN", "0x12f190a9F9d7D37a250758b26824B97CE941bF54", "Uniswap v3, 0.30%"),
    ("GOOGL", "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", "Uniswap v4, 0.30%"),
    ("META", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", "Uniswap v4, 0.30%"),
    ("COIN", "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", "Uniswap v4, 1.00%"),
]
asset_rows = "".join(f'<tr><td>{s}</td><td>{addr(a, a[:10] + "…" + a[-6:])}</td><td>{v}</td></tr>' for s, a, v in assets)

docs_toc = [("overview", "Overview"), ("deposit", "Depositing"), ("redeem", "Redeeming"), ("watch", "Each watch"),
            ("mandate", "The mandate"), ("prices", "Price protection"), ("brake", "Storm brake"),
            ("governance", "Holder votes"), ("guardian", "Guardian"), ("contracts", "Contracts"), ("risks", "Risks"), ("source", "Source and contact")]
docs_body = f'''
<section id="overview"><h2>Overview</h2>
<p>Plimsoll is a shared vault on Robinhood Chain. You deposit USDG and receive vault shares. An AI agent sets the vault's mix of eight tokenized US stocks and USDG cash every 30 minutes. The vault contract checks every plan against fixed limits before anything trades, and the agent's key has no function that can move funds out.</p>
<p>Nothing here is held by a company or a person. Your share of the vault is a token in your own wallet, and you can redeem it at any time.</p></section>

<section id="deposit"><h2>Depositing</h2>
<ol><li>Open the <a href="/console">console</a> and connect a browser wallet such as MetaMask or Rabby. The console asks your wallet to switch to Robinhood Chain (chain ID 4663).</li>
<li>Enter an amount of USDG and choose Deposit. The first time, your wallet asks you to approve USDG for the vault, then to confirm the deposit.</li>
<li>You receive PLIM shares in proportion to the vault's value. If the vault is worth 1.06 USDG per share, 1,000 USDG buys about 943.4 shares.</li></ol>
<p>Deposits value every holding at the higher of its live pool price and its reference price. Moving a pool price down before depositing therefore never buys cheaper shares. Total deposits are capped at 10,000 USDG for now, and the cap can only be raised by a holder vote.</p></section>

<section id="redeem"><h2>Redeeming</h2>
<p>Redeeming burns your shares and pays you the same slice of every holding: USDG and each stock token. No prices are involved, so a redemption cannot be front-run or mispriced. Redemptions stay open even when deposits or trading are paused.</p>
<p>If a stock token refuses a transfer, for example because its issuer paused it, that part of your payout is recorded as owed to you. The console shows a Claim button for it, and you can collect it once the token moves again.</p>
<p>After redeeming you hold the stock tokens themselves. You can sell them on Uniswap or keep them, subject to the rules where you live.</p></section>

<section id="watch"><h2>Each watch</h2>
<p>A watch is a 30-minute window. In each watch the agent can make one plan, in three steps:</p>
<ol><li><b>Seal.</b> The agent asks Claude for target weights and a short reason, checks them against the mandate, and writes only a hash of the plan to the vault. Nobody, including the agent, can change the plan after that.</li>
<li><b>Execute.</b> At least four minutes later, the agent reveals the weights. The vault recomputes the hash, runs the mandate checks, and trades through the Uniswap pools in one transaction. If any check or any trade fails, the whole plan reverts and nothing moves.</li>
<li><b>Reveal.</b> In the next watch, the written reason is published on chain and must match the hash. The logbook shows it next to the outcome, so good and bad calls stay on the record.</li></ol>
<p>The agent skips watches while the vault is empty, and holding the current mix is always an allowed plan.</p></section>

<section id="mandate"><h2>The mandate</h2>
<p>These limits are enforced by the vault contract, not by the agent. They are the launch values; a holder vote can change them.</p>
<div class="scrollx"><table class="kvt"><tbody>
<tr><td>Assets</td><td>The eight stock tokens below and USDG</td></tr>
<tr><td>Weight per stock</td><td>0%, or between 5% and 25%</td></tr>
<tr><td>Turnover</td><td>At most 8% of vault value per watch</td></tr>
<tr><td>Plans</td><td>One executed plan per watch, sealed at least 4 minutes earlier</td></tr>
<tr><td>Slippage</td><td>At most 1% beyond the pool fee, per trade</td></tr>
<tr><td>Price check</td><td>No trading if a pool price is more than 5% away from its reference price</td></tr>
<tr><td>Storm brake</td><td>A 20% share-price fall within 8 watches</td></tr>
<tr><td>Deposit cap</td><td>10,000 USDG in total</td></tr>
</tbody></table></div></section>

<section id="prices"><h2>Price protection</h2>
<p>Every stock has a reference price stored in the vault. It is updated to the pool price after each executed plan, and anyone can nudge it toward the pool price by at most 5% per watch with <span class="mono">syncRefPrice</span>. Trades are refused while a pool price sits more than 5% from its reference, and each trade must return at least the amount implied by the reference price, less the pool fee and 1%.</p>
<p>Moving the reference price far therefore takes many watches of sustained pool prices, which makes a quick manipulation of a thin pool useless against the vault.</p></section>

<section id="brake"><h2>Storm brake</h2>
<p>If the share price falls 20% below its peak over the last eight executed watches, the brake trips. From then on the only plan the vault accepts is 100% cash, and new deposits stop. Only a holder vote can reset it.</p></section>

<section id="governance"><h2>Holder votes</h2>
<p>PLIM shares are also votes. To use them, turn on voting power once in the console; this delegates your votes to yourself and costs a small amount of gas.</p>
<ul><li>Anyone with at least 100 shares of voting power can make a proposal.</li>
<li>Voting opens one hour after a proposal and lasts three days.</li>
<li>A proposal passes with more votes for than against and at least 10% of all shares voting.</li>
<li>A passed proposal waits 72 hours in the timelock before anyone can execute it. That gives holders who disagree time to redeem.</li></ul>
<p>Proposals can change the limits, the deposit cap, the agent, the guardian, and pauses. They cannot add new assets or move holders' funds. Proposals are created on the <a href="{EXPLORER}/address/{dep["governor"]}" rel="noopener" target="_blank">governor contract</a>; the repository explains how to encode one.</p></section>

<section id="guardian"><h2>Guardian</h2>
<p>The guardian can pause deposits or trading in an emergency. It cannot unpause, change limits, or touch funds. Unpausing takes a holder vote.</p></section>

<section id="contracts"><h2>Contracts</h2>
<div class="scrollx"><table class="kvt"><tbody>
<tr><td>Vault (PLIM shares)</td><td>{addr(dep["vault"])}</td></tr>
<tr><td>Governor</td><td>{addr(dep["governor"])}</td></tr>
<tr><td>Timelock</td><td>{addr(dep["timelock"])}</td></tr>
<tr><td>Agent key</td><td>{addr(dep["agent"])}</td></tr>
<tr><td>Guardian</td><td>{addr(dep["guardian"])}</td></tr>
<tr><td>USDG</td><td>{addr("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")}</td></tr>
</tbody></table></div>
<h3>Stock tokens and pools</h3>
<div class="scrollx"><table class="kvt"><thead><tr><th>Stock</th><th>Token</th><th>Pool</th></tr></thead><tbody>{asset_rows}</tbody></table></div>
<p>Each pool pairs the stock with USDG and has no hooks. Many look-alike tokens exist on Robinhood Chain; only the addresses above are used by the vault.</p></section>

<section id="risks"><h2>Risks</h2>
<ul><li>Stock prices can fall, and the vault can lose value even when every limit is respected.</li>
<li>The contracts have not been reviewed by an independent auditor. A bug could lose deposits.</li>
<li>Robinhood controls its stock tokens and can pause them, block addresses, or adjust balances.</li>
<li>Pools can run thin, which raises trading costs or blocks trades.</li>
<li>The agent can make poor calls within the limits. Its reasoning is published so holders can judge it.</li>
<li>Holding or trading tokenized stocks may be restricted where you live.</li></ul>
<p>Read the <a href="/terms">terms</a> before depositing.</p></section>

<section id="source"><h2>Source and contact</h2>
<p>The contracts, the agent, the website and the tests are public on <a href="{GH_URL}" rel="noopener" target="_blank">GitHub</a>. Updates are posted on <a href="{X_URL}" rel="noopener" target="_blank">X @plimsollvault</a>.</p></section>
'''

# ------------------------------------------------------------------ terms
terms_toc = [("t1", "Using Plimsoll"), ("t2", "No advice"), ("t3", "Where you live"), ("t4", "Your wallet"),
             ("t5", "Risks"), ("t6", "Fees"), ("t7", "No custody"), ("t8", "Availability"), ("t9", "Liability"), ("t10", "Changes and contact")]
terms_body = f'''
<p class="lead">These terms apply to plimsollvault.com and the Plimsoll interface. By using the site or the Plimsoll contracts through it, you agree to them. "We" means the people who build and run Plimsoll.</p>
<section id="t1"><h2>Using Plimsoll</h2><p>Plimsoll is software. The website is an interface to smart contracts on Robinhood Chain that anyone can use directly. We do not hold your funds, run accounts, or approve transactions on your behalf.</p></section>
<section id="t2"><h2>No advice</h2><p>Nothing on this site is investment, legal, or tax advice, or an offer to buy or sell anything. The agent's plans and published reasoning are automated outputs, not recommendations to you.</p></section>
<section id="t3"><h2>Where you live</h2><p>Tokenized stocks and vault shares may be restricted or prohibited in your country. You are responsible for checking and following the laws that apply to you. Do not use Plimsoll where it is not allowed, or if you are subject to sanctions.</p></section>
<section id="t4"><h2>Your wallet</h2><p>You control your wallet and its keys. Transactions you sign are final and cannot be reversed by us. Check every transaction in your wallet before you confirm it. You are responsible for any taxes on your deposits, redemptions, and gains.</p></section>
<section id="t5"><h2>Risks</h2><p>You can lose some or all of what you deposit. The main risks are described in the <a href="/docs#risks">docs</a>, including market losses, contract bugs, actions by the token issuer, thin liquidity, and poor agent decisions. The contracts have not been reviewed by an independent auditor. Deposit only what you can afford to lose.</p></section>
<section id="t6"><h2>Fees</h2><p>Plimsoll charges no deposit, redemption, or management fee. You pay network gas for your own transactions, and the vault pays pool fees and slippage when it trades.</p></section>
<section id="t7"><h2>No custody</h2><p>Funds sit in the vault contract, and your claim on them is the PLIM shares in your wallet. Changes to the vault's settings go through the holder vote and a 72-hour timelock, not through us.</p></section>
<section id="t8"><h2>Availability</h2><p>The site, the agent, and the RPC providers it uses may be slow or unavailable at times. If the site is down, you can still redeem by calling the vault contract directly, for example from the block explorer.</p></section>
<section id="t9"><h2>Liability</h2><p>Plimsoll is provided as is, without warranties of any kind. To the fullest extent the law allows, we are not liable for losses arising from your use of the site or the contracts, including losses caused by bugs, market movements, third-party services, or the token issuer.</p></section>
<section id="t10"><h2>Changes and contact</h2><p>We may update these terms. The date at the top shows the latest version, and continued use means you accept it. Questions go to <a href="{X_URL}" rel="noopener" target="_blank">@plimsollvault on X</a>.</p></section>
'''

# ------------------------------------------------------------------ privacy
privacy_toc = [("p1", "In short"), ("p2", "What our server logs"), ("p3", "Your wallet address"), ("p4", "Services the site loads"),
               ("p5", "The agent"), ("p6", "Cookies and tracking"), ("p7", "Your choices"), ("p8", "Changes and contact")]
privacy_body = f'''
<p class="lead">Plimsoll has no accounts, no sign-up, no cookies, and no analytics. This page explains the little data that still passes through when you use the site.</p>
<section id="p1"><h2>In short</h2><ul><li>We do not ask for your name, email, or any other personal details.</li><li>Our web server keeps standard access logs for about two weeks.</li><li>Your wallet address is read in your browser and is never sent to us.</li><li>Blockchain transactions are public by design.</li></ul></section>
<section id="p2"><h2>What our server logs</h2><p>When you load plimsollvault.com, our web server records the request: your IP address, the page, the time, and your browser's user agent. We use these logs only to keep the site running and secure, and they are deleted on a rolling basis after about 14 days.</p></section>
<section id="p3"><h2>Your wallet address</h2><p>When you connect a wallet, the console reads your address and balances directly from Robinhood Chain in your browser. We do not store it. Deposits, redemptions, and votes are public blockchain transactions that anyone can see, linked to your address, and they cannot be deleted.</p></section>
<section id="p4"><h2>Services the site loads</h2><p>To work, your browser contacts these third parties, which receive your IP address and see their own part of the traffic:</p><ul><li>Google Fonts, for the typefaces.</li><li>jsDelivr, which serves the ethers library.</li><li>Robinhood Chain RPC providers (Nodeflare, Robinhood, thirdweb, PublicNode), which answer blockchain reads and see the addresses queried.</li><li>Your wallet extension, under its own privacy policy.</li></ul><p>Links to the block explorer, X, and GitHub open their sites under their own policies.</p></section>
<section id="p5"><h2>The agent</h2><p>The agent sends market data to Anthropic's Claude API to plan each watch: prices, the vault's holdings, and its limits. It never sends anything about individual users.</p></section>
<section id="p6"><h2>Cookies and tracking</h2><p>The site sets no cookies and runs no analytics, advertising, or tracking scripts.</p></section>
<section id="p7"><h2>Your choices</h2><p>You can use the site without connecting a wallet. To avoid the third-party requests listed above, you can use the vault contract directly from the block explorer instead of this site.</p></section>
<section id="p8"><h2>Changes and contact</h2><p>If this policy changes, the date at the top will change with it. Questions go to <a href="{X_URL}" rel="noopener" target="_blank">@plimsollvault on X</a>.</p></section>
'''

pages = [
    ("docs", "Plimsoll Docs", "How the Plimsoll vault works: deposits, redemptions, each watch, the mandate, holder votes, contracts and risks.", "Documentation", "How Plimsoll works", docs_body, docs_toc),
    ("terms", "Plimsoll Terms", "Terms for using plimsollvault.com and the Plimsoll contracts.", "Terms of use", "Terms", terms_body, terms_toc),
    ("privacy", "Plimsoll Privacy", "What data passes through plimsollvault.com: no accounts, no cookies, no analytics.", "Privacy policy", "Privacy", privacy_body, privacy_toc),
]
for slug, title, desc, note, h1, body, toc in pages:
    (WEB / f"{slug}.html").write_text(shell(slug, title, desc, note, h1, body, toc), encoding="utf-8", newline="\n")
    print("wrote", slug)

# ------------------------------------------------------------------ index: same nav and footer
idx = (WEB / "index.html").read_text(encoding="utf-8")
idx = re.sub(r'<nav class="links" aria-label="Sections">.*?</nav>', f'<nav class="links" aria-label="Sections">{NAV_LINKS}<a href="/#trim">Trim lab</a></nav>'.replace('<a href="/docs">Docs</a><a href="/#trim">Trim lab</a>', '<a href="/#trim">Trim lab</a><a href="/docs">Docs</a>'), idx, count=1, flags=re.S)
if 'class="icon-link"' not in idx:
    idx = idx.replace('<div class="inrow" style="flex-wrap:nowrap"><button class="btn small" id="navConnect"', f'<div class="inrow" style="flex-wrap:nowrap">{NAV_SOCIAL}<button class="btn small" id="navConnect"', 1)
idx = re.sub(r'<footer>.*?</footer>', FOOTER, idx, count=1, flags=re.S)
if 'name="twitter:site"' not in idx:
    idx = idx.replace('<meta name="twitter:card" content="summary_large_image">', '<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:site" content="@plimsollvault">', 1)
(WEB / "index.html").write_text(idx, encoding="utf-8", newline="\n")
print("index nav and footer updated")
