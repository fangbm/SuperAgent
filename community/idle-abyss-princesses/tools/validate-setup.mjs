import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8').replace(/^\uFEFF/, '');
const json = (path) => JSON.parse(read(path));
const state = json('server-state.json');
const spec = json('onboarding-spec.json');
const tags = json('forum-tags.json');
const index = json('content/content-index.json');
const names = ['绯娜', '诺艾尔', '塞西莉亚', '琳恩', '缇亚', '伊格妮', '薇拉', '云遥'];

assert.equal(state.guildId, '1567099916126527530');
assert.equal(state.starterChannelId, '1567099917372227679');
assert.equal(state.invite.url, 'https://discord.gg/pCKZvmNhFe');
assert.equal(state.invite.expiresAt, null);
assert.equal(state.automation.archiveBot, 'not_installed_or_activated');
const roleNames = ['languages', 'characters', 'interests', 'notifications']
  .flatMap((group) => spec.roles[group].map((role) => role.name));
assert.equal(roleNames.length, 21);
assert.equal(new Set(roleNames).size, 21);
assert.deepEqual([...state.roles.names].sort(), [...roleNames].sort());
assert.equal(spec.roles.characters.length, 8);
names.forEach((name, i) => assert.ok(spec.roles.characters[i].name.includes(name)));
assert.equal(spec.channels.default.length, 9);
assert.deepEqual(state.onboarding.defaultChannels, spec.channels.default.map((channel) => channel.name));
assert.equal(spec.channels.default.filter((channel) => channel.everyoneSend && channel.type !== 'forum').length, 5);
assert.deepEqual(spec.onboardingQuestions.map((question) => question.choices.length), [5, 5, 8, 3]);
for (const question of spec.onboardingQuestions) {
  for (const choice of question.choices) assert.ok(roleNames.includes(choice.role));
}
const notifications = spec.onboardingQuestions.find((question) => question.id === 'notifications');
assert.equal(notifications.required, false);
assert.equal(notifications.askBeforeJoin, false);
assert.deepEqual(notifications.defaultAssignedRoles, []);
assert.equal(tags.forums.length, 3);
assert.equal(tags.forums.reduce((total, forum) => total + forum.tags.length, 0), 51);
for (const forum of tags.forums) {
  assert.equal(forum.requireAtLeastOneTag, false);
  assert.equal(new Set(forum.tags.map((tag) => tag.name)).size, forum.tags.length);
  for (const tag of forum.tags) {
    assert.ok([...tag.name].length <= 20);
    assert.equal(tag.moderated, tag.group === 'staff_status');
  }
}
assert.equal(index.posts.length, 15);
for (const post of index.posts) {
  const content = read(`content/${post.file}`);
  assert.ok(content.length <= index.post_limit_utf16_units, post.file);
  assert.ok(!/@(?:everyone|here)\b/.test(content), `Mass mention: ${post.file}`);
  assert.ok(['message', 'native_forum_guidelines'].includes(post.appliedAs), post.file);
}
for (const asset of json('assets/source-manifest.json')) {
  const bytes = readFileSync(new URL(asset.file, root));
  assert.equal(bytes.length, asset.bytes, asset.file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.file);
}
console.log('Setup checks passed: 21 roles, 9 defaults, 51 tags, 15 content items and original artwork hashes.');
