import fs from 'fs';
import path from 'path';

// Realpath of the nearest existing ancestor + the not-yet-existing remainder,
// so a destination under a symlinked directory is resolved to where it really lands.
function realpathLoose(abs) {
    let cur = abs;
    const rest = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(cur), ...rest.reverse());
        }
        catch (e) {
            const parent = path.dirname(cur);
            if (parent === cur)
                return abs;
            rest.push(path.basename(cur));
            cur = parent;
        }
    }
}

/**
 * Resolve `p` against `root` following symlinks, and report whether it lands inside root.
 * With `noFollowLast`, the final component is not dereferenced (delete/move act on the
 * link itself, not on its target), but every parent directory still is.
 */
export function resolveGuarded(p, root, { noFollowLast = false } = {}) {
    const abs = path.resolve(root, p);
    const rootReal = realpathLoose(root);
    let real;
    if (noFollowLast && abs !== path.dirname(abs)) {
        real = path.join(realpathLoose(path.dirname(abs)), path.basename(abs));
    }
    else {
        real = realpathLoose(abs);
    }
    const inside = real === rootReal || real.startsWith(rootReal + path.sep);
    return { abs, real, inside };
}

/**
 * Decide whether a destructive operation may proceed.
 * Returns null when allowed, otherwise the message to hand back to the model.
 */
export function checkDestructive({ inside, isOwner, optIn, confirmed, autoHealActive = false, label = '' }) {
    if (inside)
        return null;
    if (!isOwner)
        return `Refused: ${label} is outside the project folder. Only the owner may modify files outside the project.`;
    if (!optIn)
        return `Refused: ${label} is outside the project folder and outside-project writes are disabled. The owner must enable settings.ai.allowOutsideWrites (or AI_ALLOW_OUTSIDE_WRITES=true) first.`;
    if (autoHealActive)
        return `Refused: ${label} is outside the project folder; this is not allowed during auto-heal.`;
    if (!confirmed)
        return `CONFIRM_REQUIRED: ${label} is outside the project folder. Ask the owner explicitly whether they are sure; only if they explicitly agree, call this tool again with confirmed: true.`;
    return null;
}
