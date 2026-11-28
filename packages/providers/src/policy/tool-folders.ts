import { homeOf, isWin, type PathContext, resolveAgainst } from "./paths";

/**
 * Where tools are normally installed (§11.2, #153): programs there are judged by their own rules,
 * and the files that set a shell up for them may be sourced, like the shell's own start-up files.
 * Writing in any of these folders asks, so nothing an agent could plant is in one.
 */

const HOMEBREW = String.raw`(?:opt\/homebrew|usr\/local|home\/linuxbrew\/\.linuxbrew)`;
const CONDA = String.raw`(?:mini|ana|micro)?(?:conda|forge|mamba)\w*`;
const CONDA_BIN = String.raw`${CONDA}\/(?:envs\/[^/]+\/)?bin\/[^/]+`;

const SYSTEM_BIN = [
  /^\/(?:usr\/(?:local\/(?:go\/)?)?)?s?bin\/[^/]+$/,
  new RegExp(
    `^\\/${HOMEBREW}\\/(?:(?:opt\\/[^/]+|Cellar\\/[^/]+\\/[^/]+)\\/)?(?:lib)?s?(?:bin|exec)\\/[^/]+$`,
  ),
  new RegExp(
    `^\\/(?:opt|opt\\/homebrew|opt\\/homebrew\\/Caskroom\\/[^/]+)\\/(?:${CONDA_BIN}|base\\/bin\\/[^/]+)$`,
  ),
  /^\/usr\/libexec\/.+$/,
  /^\/Applications\/.+$/,
];
const HOME_BIN = [
  /^\/\.(?:local|cargo|bun)\/bin\/[^/]+$/,
  /^\/\.nvm\/versions\/node\/[^/]+\/bin\/[^/]+$/,
  /^\/(?:Library\/pnpm|\.local\/share\/pnpm)\/(?:bin\/)?[^/]+$/,
  new RegExp(`^\\/(?:opt\\/)?\\.?${CONDA_BIN}$`),
];
const SYSTEM_SETUP = [
  /^\/(?:opt\/homebrew|usr\/local)\/opt\/nvm\/(?:nvm\.sh|etc\/bash_completion\.d\/nvm)$/,
  new RegExp(`^\\/opt\\/(?:homebrew\\/)?${CONDA}\\/etc\\/profile\\.d\\/conda\\.sh$`),
  /^\/etc\/(?:profile|bashrc|bash\.bashrc|zshrc|zprofile|zshenv|zsh\/(?:zshrc|zprofile|zshenv))$/,
];
const HOME_SETUP = [
  /^\/\.nvm\/(?:nvm\.sh|bash_completion)$/,
  /^\/\.(?:virtualenvs|venvs)\/[^/]+\/bin\/activate$/,
  /^\/\.venv\/bin\/activate$/,
  /^\/\.cargo\/env$/,
  new RegExp(`^\\/\\.?${CONDA}\\/etc\\/profile\\.d\\/conda\\.sh$`),
  /^\/\.(?:zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|bash_login|bash_aliases|profile)$/,
];

/** The part of `abs` below the home folder, starting with `/`; empty when it isn't there. */
function belowHome(abs: string, ctx: PathContext): string {
  const home = homeOf(ctx).replace(/\/+$/, "");
  return home && abs.startsWith(`${home}/`) ? abs.slice(home.length) : "";
}

const matches = (system: RegExp[], home: RegExp[], file: string, ctx: PathContext): boolean => {
  const abs = resolveAgainst(file, ctx);
  const below = belowHome(abs, ctx);
  return system.some((re) => re.test(abs)) || home.some((re) => re.test(below));
};

/** True when the program at `file` is one of an installed tool's. */
export const isInstalledTool = (file: string, ctx: PathContext): boolean =>
  matches(SYSTEM_BIN, HOME_BIN, file, ctx);

/**
 * True when `file` sets a shell up: for nvm, Conda, Cargo or a virtualenv, where those are normally
 * installed, or the shell's own start-up file.
 */
export const isSetupFile = (file: string, ctx: PathContext): boolean =>
  !isWin(ctx) && matches(SYSTEM_SETUP, HOME_SETUP, file, ctx);
