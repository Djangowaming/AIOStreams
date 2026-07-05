import {
  Addon,
  Option,
  ParsedStream,
  Stream,
  UserData,
} from '../db/index.js';
import { Preset } from './preset.js';
import {
  constants,
  createLogger,
  HTTP_STREAM_TYPE,
  RESOURCES,
} from '../utils/index.js';
import { config as appConfig } from '../config/index.js';
import { FileParser, StreamParser } from '../parser/index.js';

const supportedResources = [
  constants.STREAM_RESOURCE,
  constants.SUBTITLES_RESOURCE,
];

class PenguPlayStreamParser extends StreamParser {
  private readonly logger = createLogger('penguplay-parser');

  override parse(stream: Stream): ParsedStream | { skip: true } {
    this.logger.debug(
      {
        name: stream.name,
        description: stream.description,
        url: stream.url,
        title: stream.title,
        infoHash: stream.infoHash,
        externalUrl: stream.externalUrl,
        nzbUrl: stream.nzbUrl,
        ytId: stream.ytId,
        behaviorHints: stream.behaviorHints,
      },
      'raw penguplay stream'
    );
    return super.parse(stream);
  }

  protected override get indexerRegex(): RegExp | undefined {
    // Match the source/provider indicator at the end of description lines
    // PenguPlay uses both 🔗 and 🛰️ emojis for source lines
    return /(?:^|\n)\s*(?:🔗|🛰️)\s*(?:Source:\s*)?(.+?)(?:\n|$)/i;
  }

  protected override getFilename(
    stream: Stream,
    currentParsedStream: ParsedStream
  ): string | undefined {
    const description = stream.description || stream.title;
    if (!description) return undefined;

    const lines = description
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Parse description lines by emoji prefix for structured extraction
    let titleLine: string | undefined;
    let formatLine: string | undefined;

    for (const line of lines) {
      if (line.startsWith('🍿')) {
        titleLine = line.replace(/^🍿\s*/, '').trim();
      } else if (line.startsWith('🎞️') || line.startsWith('🎞')) {
        formatLine = line.replace(/^🎞️?\s*/, '').trim();
      }
    }

    // Fallback: use first line as title if no 🍿 found
    if (!titleLine) {
      titleLine = lines[0]?.replace(/^\P{L}+/u, '').trim();
      // If second line doesn't look like metadata, don't treat it as format
      if (!formatLine && lines.length > 1) {
        formatLine = lines[1]?.replace(/^\P{L}+/u, '').trim();
      }
    }

    // Combine title and format info so FileParser can extract year, resolution,
    // codecs, quality, container, etc. from the combined string
    if (titleLine && formatLine) {
      // Strip the bitrate (~XX Mbps) and trailing separators from the format line
      const cleanFormat = formatLine
        .replace(/~\d+(\.\d+)?\s*Mbps/i, '')
        .replace(/[\s•]+$/g, '')
        .trim();
      return `${titleLine} ${cleanFormat}`;
    }

    if (titleLine) return titleLine;
    return undefined;
  }

  protected override getResolution(
    stream: Stream,
    currentParsedStream: ParsedStream
  ): string | undefined {
    const text = [
      stream.name,
      stream.description,
      currentParsedStream.filename,
    ]
      .filter(Boolean)
      .join(' ');

    const resMatch = text.match(
      /\b(4K|2160p|1440p|1080p|720p|540p|480p|360p|240p)\b/i
    );

    if (resMatch) {
      const res = resMatch[1].toUpperCase();
      if (res === '4K') return '2160p';
      return res.toLowerCase();
    }

    return undefined;
  }

  protected override getBitrate(
    stream: Stream,
    currentParsedStream: ParsedStream
  ): number | undefined {
    // Extract bitrate from the 🎞️ format line, e.g. "~16.7 Mbps"
    const text = stream.description || stream.title || '';
    const match = text.match(/~(\d+(?:\.\d+)?)\s*Mbps/i);
    if (match) {
      return Math.round(parseFloat(match[1]) * 1_000_000);
    }
    return super.getBitrate(stream, currentParsedStream);
  }

  protected override getReleaseGroup(
    stream: Stream,
    currentParsedStream: ParsedStream
  ): string | undefined {
    // Extract release group from the 🛰️ source line or the addon name
    // Name format: "🐧 PenguPlay ❄️ 4K • 4KHDHub · FSL"
    // 🛰️ line format: "Source: 4KHDHub · FSL"
    const description = stream.description || '';
    const sourceMatch = description.match(
      /(?:^|\n)\s*🛰️\s*(?:Source:\s*)?(.+?)(?:\n|$)/i
    );
    if (sourceMatch) {
      // Take the first part before "·" as the primary release group
      const source = sourceMatch[1].trim();
      const parts = source.split(/\s*·\s*/);
      return parts[0].trim() || undefined;
    }
    return undefined;
  }
}

export class PenguPlayPreset extends Preset {
  static override getParser(): typeof StreamParser {
    return PenguPlayStreamParser;
  }

  static override get METADATA() {
    const options: Option[] = [
      {
        id: 'name',
        name: 'Name',
        description: 'What to call this addon',
        type: 'string',
        required: true,
        default: 'PenguPlay',
      },
      {
        id: 'installationUrl',
        name: 'Installation URL',
        description:
          'Provide your PenguPlay installation URL from [pengu.uk](https://pengu.uk/). Configure your preferred sources and filters on the website, then copy the install URL.',
        type: 'password',
        required: true,
      },
      {
        id: 'timeout',
        name: 'Timeout (ms)',
        description: 'The timeout for this addon',
        type: 'number',
        default:
          appConfig.presets.penguplay.defaultTimeout ??
          appConfig.presets.defaultTimeout,
        constraints: {
          min: appConfig.userLimits.timeouts.minTimeout,
          max: appConfig.userLimits.timeouts.maxTimeout,
          forceInUi: false,
        },
      },
      {
        id: 'resources',
        name: 'Resources',
        description:
          'Optionally override the resources that are fetched from this addon',
        type: 'multi-select',
        required: false,
        default: undefined,
        options: RESOURCES.map((resource) => ({
          label: resource,
          value: resource,
        })),
        showInSimpleMode: false,
      },
      {
        id: 'socials',
        name: '',
        description: '',
        type: 'socials',
        socials: [
          { id: 'website', url: 'https://pengu.uk/' },
        ],
      },
    ];

    return {
      ID: 'penguplay',
      NAME: 'PenguPlay',
      LOGO: 'https://pengu.uk/penguplay-icon.png',
      URL: [],
      TIMEOUT:
        appConfig.presets.penguplay.defaultTimeout ??
        appConfig.presets.defaultTimeout,
      USER_AGENT:
        appConfig.presets.penguplay.defaultUserAgent ??
        appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Stream movies and series with configurable provider and quality filters. Configure your preferences on [pengu.uk](https://pengu.uk/) and paste your installation URL.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [HTTP_STREAM_TYPE],
      SUPPORTED_RESOURCES: supportedResources,
      CATEGORY: constants.PresetCategory.STREAMS,
    };
  }

  static async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    if (!options.installationUrl?.endsWith('/manifest.json')) {
      throw new Error(
        'Invalid PenguPlay installation URL — must end with /manifest.json. Visit https://pengu.uk/ to get your URL.'
      );
    }
    return [this.generateAddon(options)];
  }

  private static generateAddon(options: Record<string, any>): Addon {
    return {
      name: options.name || this.METADATA.NAME,
      manifestUrl: options.installationUrl,
      enabled: true,
      resources: options.resources || this.METADATA.SUPPORTED_RESOURCES,
      timeout: options.timeout || this.METADATA.TIMEOUT,
      preset: {
        id: '',
        type: this.METADATA.ID,
        options,
      },
      headers: {
        'User-Agent': this.METADATA.USER_AGENT,
      },
    };
  }
}
