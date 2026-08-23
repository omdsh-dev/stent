#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { parseOpt } from './stent-dsh/args.ts'
import { main } from './stent-dsh/main.ts'

await main(parseOpt(process.argv.slice(2), process.env, new URL(import.meta.url), pathToFileURL(process.cwd())))
