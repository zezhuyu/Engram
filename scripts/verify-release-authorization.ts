import { verifyReleaseAuthorization, type ReleaseProfileName } from './lib/release-policy.js';
import { parseStrictJson } from './lib/strict-json.js';
import { currentSourceEvidence } from './lib/source-evidence.js';
import { gitCommit } from './lib/suite.js';

const fail = (reason: string): never => { console.error(`Release authorization rejected: ${reason}`); process.exit(1); };
const authorizationText = process.env.ENGRAM_RELEASE_AUTHORIZATION_JSON;
const publicKey = process.env.ENGRAM_RELEASE_AUTHORIZATION_PUBLIC_KEY;
if (!authorizationText || !publicKey) fail('owner-signed authorization and trusted public key are required');
let authorization: unknown;
try { authorization = parseStrictJson(authorizationText as string, 'release authorization'); } catch { fail('authorization is not valid strict JSON'); }
const report = await import('node:fs/promises').then(fs => fs.readFile('verification/release-report.json', 'utf8')).then(text => parseStrictJson(text, 'release report')).catch(() => undefined) as { releaseProfile?: string; releaseLevel?: string } | undefined;
const profile = process.env.MDB_RELEASE_PROFILE;
if (!report || report.releaseProfile !== profile || !['core-beta', 'full-intelligence-beta', 'ga'].includes(String(profile))) fail('release report is missing or profile does not match');
const releaseReport = report as { releaseProfile: string; releaseLevel: string };
if (releaseReport.releaseLevel !== 'BETA' && releaseReport.releaseLevel !== 'GA_ELIGIBLE') fail('selected profile is not eligible for publication');
const source = await currentSourceEvidence();
const commit = gitCommit();
const ref = process.env.GITHUB_REF;
if (!ref || !/^refs\/tags\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref)) fail('a semantic version tag ref is required');
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) fail('workflow commit does not match the checked out source');
if (!verifyReleaseAuthorization(authorization, {
  sourceFingerprint: source.fingerprint,
  ref: ref as string,
  commit,
  profile: profile as ReleaseProfileName,
  releaseLevel: releaseReport.releaseLevel as 'BETA' | 'GA_ELIGIBLE',
}, publicKey as string)) fail('signature, source, tag, profile, level, or approval timestamp is invalid');
console.log(`Owner authorization verified for ${ref} (${releaseReport.releaseLevel}, ${source.fingerprint}).`);
