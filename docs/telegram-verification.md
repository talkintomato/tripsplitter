# Telegram verification

What the bot assumes about Telegram, and whether each assumption has been checked against the real platform.

**Status on 2026-09-27: nothing here is verified.** The bot was built without a bot token, so no call was made to Telegram. Every handler was tested with fake updates only. Each item below needs the manual step listed, in a real test group.

When you check an item, replace "not verified" with "verified" or "wrong", the date, and what you saw.

## Before you start

1. Create a bot in BotFather, register the Mini App, and turn privacy mode off (`/setprivacy`, Disable).
2. Create a test group with two human accounts. Make it a basic group, not a supergroup, so item 5 can be checked. A group is basic when it is new, private and has no features such as a public link or visible history for new members.
3. Start the server with the bot token. Leave `ALLOWED_CHAT_IDS` empty, so the bot works in every chat.
4. Add the bot to the group. It should post and pin the intro message.
5. Start the bot with the `chat_member` update kind turned on. Telegram leaves it out by default. `src/bot/index.ts` exports `ALLOWED_UPDATES` for this.

## Items from the PRD

| # | Assumption | Status | Manual step |
|---|---|---|---|
| 1 | With privacy mode off, the bot receives every group message. | not verified | From the second account, which has never posted, send a plain message with no mention and no command. Open the Mini App and check that this account is listed as a member. If it is missing, remove the bot from the group and add it back, because a change of privacy mode only applies to groups joined afterwards, then repeat. |
| 2 | A mention in a photo caption reaches the bot. | not verified | Post a photo with `@<bot>` in the caption. With PRD 3 running the bot replies "Reading receipt...". Without it, log the update kinds received (not the text) and check that a message with `photo` and a `mention` entity in `caption_entities` arrived. |
| 3 | A reply to a photo that mentions the bot includes the original photo in `reply_to_message`. | not verified | Post a photo without a caption. Reply to it with `@<bot>`. Check that the update has `reply_to_message.photo` with file IDs. Repeat with a photo posted before the bot joined the group. |
| 4 | URL buttons with a `startapp` link open the Mini App from a group, and the parameter arrives as `start_param`. | not verified | Tap "Add expense" on the pinned intro message, on iOS, Android and desktop. The Mini App should open on the add screen. Check in the server log or browser tools that `initData` holds `start_param` equal to the value after `startapp=` in the button's link. |
| 5 | The group to supergroup upgrade sends `migrate_to_chat_id`. | not verified | In the basic test group, change a setting that forces the upgrade, such as making chat history visible to new members. The bot should post "This group was upgraded by Telegram and has a new chat ID: ..." in the group. Send another message and check that the bot still learns the sender without any change to `ALLOWED_CHAT_IDS`. Then restart the server and check again. |

## Other assumptions this build makes

These are not in the PRD's list. The code relies on them, and they are also not verified.

| # | Assumption | Status | Manual step |
|---|---|---|---|
| 6 | Adding the bot to a group sends a `my_chat_member` update, a message with `new_chat_members` holding the bot, or both. | not verified | Covered by step 4 of "Before you start": the refusal is posted once. |
| 7 | The bot can pin a message only as an administrator with the pin permission. Without it the intro is posted and not pinned. | not verified | Add the bot as an ordinary member to an allowed group: the intro appears unpinned and the server log has "Could not pin the intro message". Make the bot an administrator with the pin permission, reset the link from the Mini App: the new intro is pinned and the old one is unpinned. |
| 8 | `getChatAdministrators` works for a bot that is an ordinary member of the group, and lists bots with `is_bot` true. | not verified | After first set-up, check that the group's human administrators are members in the Mini App before they post anything, and that no bot is listed. |
| 9 | A post by an anonymous administrator has `sender_chat` set and `from` set to a bot account. | not verified | Turn on "Remain anonymous" for an administrator and post. No member named "Group" should appear. |
| 10 | The code entity in the refusal shows the chat ID as tap-to-copy text. | not verified | Tap the ID in the refusal message and paste it somewhere. |
| 11 | A person leaving or being removed sends a message with `left_chat_member`, and in a group of any size the bot receives it. | not verified | Have the second account leave the group. In the Mini App that member should be left out of a new split by default. |
