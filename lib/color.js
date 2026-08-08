function wrap(open, close) {
    return (text) => `\x1b[${open}m${text}\x1b[${close}m`
}

const chalk = {
    reset: wrap(0, 0),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    italic: wrap(3, 23),
    underline: wrap(4, 24),
    inverse: wrap(7, 27),
    hidden: wrap(8, 28),
    strikethrough: wrap(9, 29),

    black: wrap(30, 39),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    white: wrap(37, 39),
    gray: wrap(90, 39),
    grey: wrap(90, 39),

    blackBright: wrap(90, 39),
    redBright: wrap(91, 39),
    greenBright: wrap(92, 39),
    yellowBright: wrap(93, 39),
    blueBright: wrap(94, 39),
    magentaBright: wrap(95, 39),
    cyanBright: wrap(96, 39),
    whiteBright: wrap(97, 39),

    bgBlack: wrap(40, 49),
    bgRed: wrap(41, 49),
    bgGreen: wrap(42, 49),
    bgYellow: wrap(43, 49),
    bgBlue: wrap(44, 49),
    bgMagenta: wrap(45, 49),
    bgCyan: wrap(46, 49),
    bgWhite: wrap(47, 49),
    bgGray: wrap(100, 49),
    bgGrey: wrap(100, 49),

    bgBlackBright: wrap(100, 49),
    bgRedBright: wrap(101, 49),
    bgGreenBright: wrap(102, 49),
    bgYellowBright: wrap(103, 49),
    bgBlueBright: wrap(104, 49),
    bgMagentaBright: wrap(105, 49),
    bgCyanBright: wrap(106, 49),
    bgWhiteBright: wrap(107, 49),
}

export default chalk
