import winston, { format, transports } from "winston";

import type { Logform } from "winston";

export const setupLogger = (environment: string | undefined, logLevel: string | undefined) => {
  const isProduction = environment === "production";

  const messageFlowNamePrefixFormat = format((info) => {
    const { flowName } = info;
    return { ...info, message: flowName ? `[${flowName}] ${info.message}` : info.message };
  });

  const productionFormat = format((info) => {
    const { level, message, timestamp, ...rest } = info;
    return {
      message,
      timestamp,
      level: level.toUpperCase(),
      fields: rest,
    };
  });

  const loggerFormatters: Logform.Format[] = isProduction
    ? [
        format.timestamp({
          format: () => new Date().toISOString(),
        }),
        messageFlowNamePrefixFormat(),
        productionFormat(),
        format.json(),
      ]
    : [
        format.timestamp({
          format: "DD/MM/YYYY HH:mm:ss.SSS",
        }),
        messageFlowNamePrefixFormat(),
        format.colorize(),
        format.simple(),
      ];

  const defaultLogLevel = isProduction ? "info" : "debug";

  winston.configure({
    level: logLevel || defaultLogLevel,
    transports: [
      new transports.Console({
        format: format.combine(...loggerFormatters),
        handleExceptions: true,
      }),
    ],
  });
};
