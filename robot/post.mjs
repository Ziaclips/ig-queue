// Instagram posting robot. Runs on GitHub Actions (free) at the times set in post.yml.
// Takes the oldest clip in queue/, publishes it as a Reel, then removes it from the queue.
// Needs repository secrets IG_ACCESS_TOKEN (never-expiring Page token) and IG_USER_ID.
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const GRAPH = 'https://graph.facebook.com/v23.0';
const TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_USER = process.env.IG_USER_ID;
const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
const PAGES = `https://${owner.toLowerCase()}.github.io/${repo}`;
const summary = (s) => { console.log(s); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(path, params = {}, method = 'GET') {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = method === 'GET' ? `${GRAPH}/${path}?${body}` : `${GRAPH}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const json = await res.json();
  if (json.error) throw new Error(`Instagram said: ${json.error.message} (code ${json.error.code}${json.error.error_subcode ? '/' + json.error.error_subcode : ''})`);
  return json;
}

if (!TOKEN || !IG_USER) { summary('Not connected to Instagram yet: add the IG_ACCESS_TOKEN and IG_USER_ID repository secrets.'); process.exit(0); }

const queue = readdirSync('queue').filter((f) => f.endsWith('.json')).sort();
if (!queue.length) { summary('Queue is empty — nothing to post. Switch the laptop on so AI Clipper can send new clips.'); process.exit(0); }

// Skip anything already on Instagram (matched by the caption's first line), in case a clip was posted but not removed.
const recent = await graph(`${IG_USER}/media`, { fields: 'caption', limit: '50' });
const postedTitles = new Set((recent.data || []).map((m) => String(m.caption || '').split('\n')[0].trim()).filter(Boolean));

for (const file of queue) {
  const meta = JSON.parse(readFileSync(`queue/${file}`, 'utf8'));
  const base = file.replace(/\.json$/, '');
  const title = String(meta.caption || '').split('\n')[0].trim();
  if (postedTitles.has(title)) { summary(`Already on Instagram, removing from queue: ${title}`); execSync(`git rm -q --ignore-unmatch "queue/${base}.json" "queue/${base}.mp4"`); continue; }

  const videoUrl = `${PAGES}/queue/${encodeURIComponent(base)}.mp4`;
  const head = await fetch(videoUrl, { method: 'HEAD' });
  if (!head.ok) { summary(`Video not reachable yet (${head.status}): ${videoUrl} — will try again next time.`); process.exit(0); }

  summary(`Posting: ${title}`);
  const container = await graph(`${IG_USER}/media`, { media_type: 'REELS', video_url: videoUrl, caption: meta.caption, share_to_feed: 'true' }, 'POST');

  let status = '';
  for (let i = 0; i < 60; i++) { // wait up to 10 minutes for Instagram to process the video
    await sleep(10000);
    const s = await graph(container.id, { fields: 'status_code,status' });
    status = s.status_code;
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram could not process the video: ${s.status}`);
  }
  if (status !== 'FINISHED') throw new Error('Instagram took too long to process the video; it will be retried next time.');

  const published = await graph(`${IG_USER}/media_publish`, { creation_id: container.id }, 'POST');
  const info = await graph(published.id, { fields: 'permalink' }).catch(() => ({}));
  summary(`Posted ✅ ${info.permalink || published.id}`);

  execSync(`git rm -q --ignore-unmatch "queue/${base}.json" "queue/${base}.mp4"`);
  appendFileSync('posted.log', `${new Date().toISOString()}  ${info.permalink || published.id}  ${title}\n`);
  break; // one Reel per run
}

// Save the queue changes back to GitHub (if the laptop sent new clips meanwhile, the caption check above prevents re-posting).
const git = (cmd) => { try { execSync(cmd, { stdio: 'inherit' }); } catch { /* nothing to commit, or the push lost a race */ } };
git('git add -A queue');
try { readFileSync('posted.log'); git('git add posted.log'); } catch { /* nothing posted this run */ }
git('git -c user.name=ig-robot -c user.email=ig-robot@users.noreply.github.com commit -qm "Posted to Instagram"');
git('git push -q');
