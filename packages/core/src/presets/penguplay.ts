import {
  Addon,
  Option,
  ParsedStream,
  Stream,
  UserData,
} from '../db/index.js';
import { Preset } from './preset.js';
import { constants, HTTP_STREAM_TYPE, RESOURCES } from '../utils/index.js';
import { config as appConfig } from '../config/index.js';
import { FileParser, StreamParser } from '../parser/index.js';

const supportedResources = [
  constants.STREAM_RESOURCE,
  constants.SUBTITLES_RESOURCE,
];

class PenguPlayStreamParser extends StreamParser {
  protected override get indexerRegex(): RegExp | undefined {
    // Match the source/provider indicator at the end of description lines
    return /(?:^|\n)\s*🔗\s*(.+?)(?:\n|$)/i;
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

    // Look for lines that contain file-like patterns (year, resolution, codec, etc.)
    const filePattern =
      /\b(?:19|20)\d{2}\b|\d+p\b|\b4K\b|WEB[-. ]?DL|HDRip|BluRay|BDRip|BRRip|x\d{3}\b|HEVC|H\.?26[45]|AVC|AV1|VP9/i;

    for (const line of lines) {
      if (filePattern.test(line) || FileParser.parse(line)?.year) {
        return line
          .replace(/^\[\w+\s*\]\s*/i, '')
          .replace(/^\P{L}+/u, '')
          .trim();
      }
    }

    // Fallback: return the first line after stripping emoji/symbol prefixes
    const filename = lines[0];
    return filename?.replace(/^\P{L}+/u, '').trim();
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
