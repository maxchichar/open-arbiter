import os
import asyncio
import logging
from collections import defaultdict, deque

import discord
from discord.ext import commands
from dotenv import load_dotenv
from openai import OpenAI

import store

load_dotenv()

DISCORD_TOKEN = os.environ["DISCORD_BOT_TOKEN"]
NVIDIA_API_KEY = os.environ["NVIDIA_API_KEY"]
NIM_MODEL = os.environ.get("NIM_MODEL", "nvidia/llama-3.3-nemotron-super-49b-v1")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("away-bot")

# NVIDIA NIM exposes an OpenAI-compatible endpoint, so the OpenAI SDK works
# unchanged — just point base_url at NVIDIA and use an NVIDIA API key.
llm_client = OpenAI(
    base_url="https://integrate.api.nvidia.com/v1",
    api_key=NVIDIA_API_KEY,
)

# --- Discord setup -----------------------------------------------------
# message_content and members are "privileged" intents — enable both in the
# Discord Developer Portal (Bot tab) or the bot will fail to log in.
intents = discord.Intents.default()
intents.message_content = True
intents.members = True
intents.voice_states = True

bot = commands.Bot(command_prefix="!", intents=intents)

# Rolling per-(channel, away_user) memory so replies have some context.
# Not persisted — resets on restart. Fine for casual conversations.
history = defaultdict(lambda: deque(maxlen=10))


def build_system_prompt(persona_name: str) -> str:
    return (
        f"You are an AI stand-in replying on behalf of {persona_name}, who is "
        "currently away from Discord. Keep replies short, friendly, and natural. "
        "If anyone asks whether they're talking to a real person, be honest that "
        "you're an AI assistant filling in temporarily, not the actual person. "
        "Never claim to be human."
    )


@bot.event
async def on_ready():
    log.info(f"Logged in as {bot.user} (id: {bot.user.id}) — in {len(bot.guilds)} server(s)")
    await bot.change_presence(
        status=discord.Status.online,
        activity=discord.Game(name="!away on to try me"),
    )


@bot.command(name="away")
async def toggle_away(ctx: commands.Context, state: str, *, persona_name: str = None):
    """!away on [display name]  |  !away off  — sets YOUR away status in THIS server."""
    if ctx.guild is None:
        await ctx.send("This only works inside a server, not in DMs.")
        return

    if state.lower() in ("on", "true", "1"):
        name = persona_name or ctx.author.display_name
        store.set_away(ctx.guild.id, ctx.author.id, True, name)
        await ctx.send(
            f"You're marked **away** as *{name}*. I'll cover for you when someone "
            "@mentions you here, and I'll follow you into voice channels."
        )
    elif state.lower() in ("off", "false", "0"):
        store.set_away(ctx.guild.id, ctx.author.id, False, None)
        await ctx.send("You're marked **back**. I'll stop covering for you.")
    else:
        await ctx.send("Usage: `!away on [display name]` or `!away off`")


@bot.command(name="awaylist")
async def away_list(ctx: commands.Context):
    """Show who currently has away mode on in this server."""
    if ctx.guild is None:
        await ctx.send("This only works inside a server, not in DMs.")
        return
    rows = store.list_away(ctx.guild.id)
    if not rows:
        await ctx.send("Nobody's marked away right now.")
        return
    lines = [f"• <@{user_id}> (as *{name}*)" for user_id, name in rows]
    await ctx.send("Currently away:\n" + "\n".join(lines))


@bot.command(name="join")
async def join_voice(ctx: commands.Context):
    """Join the voice channel you're currently in."""
    if ctx.author.voice is None or ctx.author.voice.channel is None:
        await ctx.send("You need to be in a voice channel first.")
        return
    channel = ctx.author.voice.channel
    if ctx.voice_client is not None:
        await ctx.voice_client.move_to(channel)
    else:
        await channel.connect()
    await ctx.send(f"Joined **{channel.name}**.")


@bot.command(name="leave")
async def leave_voice(ctx: commands.Context):
    """Leave the current voice channel."""
    if ctx.voice_client is not None:
        await ctx.voice_client.disconnect()
        await ctx.send("Left the voice channel.")
    else:
        await ctx.send("I'm not in a voice channel.")


@bot.event
async def on_voice_state_update(member: discord.Member, before, after):
    """Auto-follow any away-marked user into whatever voice channel they join.

    Limitation: one bot instance can only be in one voice channel per guild
    at a time, so if two away users are in different channels simultaneously,
    the bot follows whichever one most recently moved.
    """
    if member.bot or member.guild is None:
        return
    if not store.is_away(member.guild.id, member.id):
        return

    guild = member.guild
    voice_client = guild.voice_client

    if after.channel is not None and before.channel != after.channel:
        try:
            if voice_client is not None:
                await voice_client.move_to(after.channel)
            else:
                await after.channel.connect()
        except discord.ClientException:
            pass
    elif after.channel is None and before.channel is not None:
        if voice_client is not None and voice_client.channel == before.channel:
            await voice_client.disconnect()


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    await bot.process_commands(message)
    if message.content.startswith(bot.command_prefix):
        return

    # DMs are ambiguous in a multi-server bot — we can't know which away
    # person the sender is trying to reach, so just point them in the
    # right direction instead of guessing.
    if isinstance(message.channel, discord.DMChannel):
        await message.channel.send(
            "Hey — I'm an away-assistant bot that lives in several servers. "
            "I can't tell who you're trying to reach over DM. @mention them "
            "in their server instead and I'll step in if they've got away "
            "mode on."
        )
        return

    if message.guild is None:
        return

    away_mentions = [
        u for u in message.mentions
        if u.id != bot.user.id and store.is_away(message.guild.id, u.id)
    ]

    if not away_mentions:
        if bot.user in message.mentions:
            await message.reply(
                "I only step in for people who've turned on `!away on` — "
                "@mention them directly and I'll cover if they're away."
            )
        return

    # v1: if multiple away people are mentioned in one message, only the
    # first gets a stand-in reply, to keep this simple.
    target = away_mentions[0]
    persona_name = store.get_persona_name(message.guild.id, target.id) or target.display_name
    key = (message.channel.id, target.id)
    history[key].append({"role": "user", "content": message.content})

    try:
        async with message.channel.typing():
            response = await asyncio.to_thread(
                llm_client.chat.completions.create,
                model=NIM_MODEL,
                max_tokens=300,
                messages=[{"role": "system", "content": build_system_prompt(persona_name)}]
                + list(history[key]),
            )
        reply_text = response.choices[0].message.content
    except Exception:
        log.exception("NVIDIA NIM API error")
        reply_text = "Sorry, I'm having trouble responding right now."

    history[key].append({"role": "assistant", "content": reply_text})
    await message.reply(reply_text)


if __name__ == "__main__":
    store.init_db()
    bot.run(DISCORD_TOKEN)
