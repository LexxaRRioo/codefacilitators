import * as core from '@actions/core'
import * as github from '@actions/github'
import { Context } from '@actions/github/lib/context'
import type { GitHub } from '@actions/github/lib/utils'
import { promises as fs } from 'fs'
import ignore from 'ignore'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    core.notice('=== Starting action ===')
    const context: Context = github?.context
    const githubToken: string = core.getInput('token')
    const file: string = core.getInput('file')

    core.notice('Input file path:', file)

    if (!githubToken) {
      return core.setFailed(`Required input "token" not provided`)
    }
    if (!file) {
      return core.setFailed(`Required input "file" not provided`)
    }
    if (!hasValidOwnerInContext(context)) {
      return core.setFailed(`Valid owner is missing from context`)
    }
    if (!hasValidRepoInContext(context)) {
      return core.setFailed(`Valid repo is missing from context`)
    }
    if (!hasValidPullRequestNumberInContext(context)) {
      return core.setFailed(`Valid Pull Request number is missing from context`)
    }

    core.setSecret(githubToken)
    const octokit = github.getOctokit(githubToken)

    // Read the file
    const data = await fs.readFile(file, 'utf-8')
    core.notice('File content:', data)

    const changedFiles = await getChangedFiles(octokit, context)
    core.notice('Changed files:', changedFiles)
    
    const reviewers = await parseFileData(data, changedFiles, octokit)
    core.notice('Parsed reviewers:', reviewers)
    
    const filteredReviewers = await filterReviewers(reviewers, octokit, context)
    core.notice('Filtered reviewers:', filteredReviewers)

    if (filteredReviewers.length === 0) {
      core.notice('No reviewers found after filtering')
      return
    }

    core.notice('Requesting reviewers:', filteredReviewers)
    await octokit.rest.pulls.requestReviewers({
      owner: context?.repo?.owner,
      repo: context?.repo?.repo,
      pull_number: Number(context?.payload?.pull_request?.number),
      reviewers: filteredReviewers
    })
    core.notice('Successfully requested reviewers')

} catch (error) {
    console.error('Action failed with error:', error)
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function parseFileData(
  data: string,
  changedFiles: string[],
  octokit: InstanceType<typeof GitHub>
): Promise<string[]> {
  const reviewers: string[] = []

  core.notice('=== Starting parseFileData ===')
  core.notice('Changed files:', changedFiles)

  for (const file of changedFiles) {
    core.notice('\nProcessing file:', file)
    
    for (const line of data.split('\n')) {
      core.notice('\n--- Processing line:', line)
      let finalReviewers: string[] | undefined

      if (line.startsWith('#') || line.trim() === '') {
        core.notice('Skipping comment or empty line:', line)
        continue
      }

      const parsedLined = line.replace(/\s+/g, ' ').split(' ')
      core.notice('Parsed line parts:', parsedLined)
      
      if (parsedLined.length < 2) {
        core.notice('Skipping incorrect line:', line, '(parts:', parsedLined.length, ')')
        continue
      }

      const ig = ignore().add(parsedLined[0])
      core.notice('Checking if', file, 'matches pattern', parsedLined[0])
      if (ig.ignores(file)) {
        core.notice('✓ File', file, 'matches pattern', parsedLined[0])
        
        for (const reviewer of parsedLined.slice(1)) {
          core.notice('Processing reviewer:', reviewer)
          if (!reviewer.startsWith('@')) {
            core.notice('Skipping invalid reviewer:', reviewer, '(doesn\'t start with @)')
            continue
          }

          const reviewerName = reviewer.substring(1)
          core.notice('Reviewer name after @ removal:', reviewerName)
          
          if (reviewerName.includes('/')) {
            core.notice('Getting members for team:', reviewerName)
            const groupsSplitted = reviewerName.split('/')
            try {
              const { data: members } = await octokit.rest.teams.listMembersInOrg(
                {
                  org: groupsSplitted[0],
                  team_slug: groupsSplitted[1]
                }
              )
              finalReviewers = members.map(member => member.login)
              core.notice('Found team members:', finalReviewers)
            } catch (error) {
              console.error('Failed to get team members:', error)
              if (error instanceof Error && 'status' in error) {
                console.error('Status:', (error as any).status)
                console.error('Response:', (error as any).response?.data)
              }
            }
          } else {
            finalReviewers = [reviewerName]
            core.notice('Added individual reviewer:', reviewerName)
          }
        }
      } else {
        core.notice('✗ File', file, 'does NOT match pattern', parsedLined[0])
      }
      
      if (finalReviewers) {
        core.notice('>>> BEFORE Adding reviewers. Current list:', reviewers)
        core.notice('>>> Adding reviewers:', finalReviewers)
        reviewers.push(...finalReviewers)
        core.notice('>>> AFTER Adding reviewers. New list:', reviewers)
      } else {
        core.notice('No finalReviewers set for this iteration')
      }
    }
  }

  core.notice('=== Finished parseFileData ===')
  core.notice('Final reviewers list:', reviewers)
  return reviewers
}

async function filterReviewers(
  reviewers: string[],
  octokit: InstanceType<typeof GitHub>,
  context: Context
): Promise<string[]> {
  if (
    !context?.payload?.pull_request?.number ||
    !context?.repo?.owner ||
    !context?.repo?.repo
  ) {
    throw new Error('Invalid context')
  }
  core.notice('=== Starting filterReviewers ===')
  core.notice('Input reviewers:', reviewers)

  const { data: pull } = await octokit.rest.pulls.get({
    owner: context?.repo?.owner,
    repo: context?.repo?.repo,
    pull_number: context?.payload?.pull_request?.number
  })
  core.notice('PR author:', pull.user.login)

  const filtered = reviewers.filter(
    (reviewer, index) =>
      reviewers.indexOf(reviewer) === index && reviewer !== pull.user.login
  )
  core.notice('Filtered reviewers:', filtered)
  return filtered
}

async function getChangedFiles(
  octokit: InstanceType<typeof GitHub>,
  context: Context
): Promise<string[]> {
  if (
    !context?.payload?.pull_request?.number ||
    !context?.repo?.owner ||
    !context?.repo?.repo
  ) {
    throw new Error('Invalid context')
  }

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: context?.repo?.owner,
    repo: context?.repo?.repo,
    pull_number: context?.payload?.pull_request?.number
  })

  return files.map(file => file.filename)
}

function hasValidOwnerInContext(context: Context): boolean {
  return !!context?.repo?.owner
}

function hasValidRepoInContext(context: Context): boolean {
  return !!context?.repo?.repo
}

function hasValidPullRequestNumberInContext(context: Context): boolean {
  return !!Number(context?.payload?.pull_request?.number)
}
