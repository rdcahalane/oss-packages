export const HELP_TEXT = `
**Board of Advisor Agents — Commands**

**Board mode** (multi-advisor synthesis)
\`!board: topic\` — auto-selects the most relevant advisors for your topic
\`!board cfo cmo cto: topic\` — force specific advisors
\`!board plan: topic\` or \`!plan: topic\` — preview which advisors would be selected and their angles, without running the session
_Board sessions now include an adversarial critic pass before synthesis — finding the 2-3 weakest claims before the final verdict._

**Debate mode** (two agents argue it out)
\`!debate: topic\` — default agents (claude vs local), 2 rounds each
\`!debate all: topic\` — full model panel: claude · beast · canoe · gemini · codex · kimi (unavailable ones skip automatically)
\`!debate all 2: topic\` — three-way, 2 cycles (6 rounds total before synthesis)
\`!debate claude vs gemini 3: topic\` — two agents, 3 cycles (6 rounds)
\`!debate --red gemini: topic\` — one agent plays devil's advocate
\`!debate --socratic claude: topic\` — one agent applies causal/Socratic reasoning

**Direct agent**
\`!claude: prompt\` · \`!beast: prompt\` · \`!gemini: prompt\` · \`!local: prompt\` · \`!codex: prompt\`
_(no prefix = auto-routed)_

**Web search**
\`!search: query\` — fetch live web results and answer (also: \`!web:\` \`!google:\` \`!lookup:\`)
_Paste a URL in any message to auto-fetch its content. Questions about current events/prices/news auto-search._

**Self-improvement**
\`!teach: <instruction>\` — add a behavior rule (e.g. "always answer in bullet points")
\`!forget: <rule text or number>\` — remove a rule
\`!rules\` — list all current rules

**After a board or debate**
\`!approve\` — execute the proposed action
\`!reject\` — dismiss, no action
\`!ask\` — ask Claude follow-up questions about the synthesis
\`!ask what are the biggest risks?\` — ask something specific

**Advisor roster**
\`!roster\` — list active and kicked advisors
\`!kick advisorId\` — remove an advisor from this channel
\`!invite advisorId\` — reinstate a kicked advisor

**Advisor IDs** (professional): \`cfo\` \`cmo\` \`cto\` \`coo\` \`gc\` \`cpo\` \`ux\`
**Advisor IDs** (fun): \`grandma\` \`teenager\` \`neighbor\` \`intern\` \`shark\`
_Custom advisors: edit \`advisors.md\` in the project root._
`.trim();
