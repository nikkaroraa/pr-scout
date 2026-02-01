#!/usr/bin/env node

/**
 * pr-scout - AI-powered PR review tool
 * 
 * Features:
 * - AI summary of PR intent
 * - Feature-based file grouping (not alphabetical)
 * - Interactive walkthrough of changes
 * - Quiz mode before approval
 */

const { execSync, spawn } = require('child_process');
const readline = require('readline');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  model: process.env.PR_SCOUT_MODEL || 'claude',
  quizQuestions: parseInt(process.env.PR_SCOUT_QUIZ_QUESTIONS || '3', 10),
  passingScore: 0.66, // Need 2/3 correct to pass
};

// ============================================================================
// Utility Functions
// ============================================================================

function exec(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options }).trim();
  } catch (err) {
    if (options.ignoreError) return '';
    throw err;
  }
}

function print(text = '') {
  console.log(text);
}

function printHeader(text) {
  const line = '━'.repeat(52);
  print(`\n${line}`);
  print(text);
  print(line);
}

function printBox(title, content) {
  print(`\n┌${'─'.repeat(50)}┐`);
  print(`│ ${title.padEnd(48)} │`);
  print(`├${'─'.repeat(50)}┤`);
  content.split('\n').forEach(line => {
    const wrapped = wrapText(line, 48);
    wrapped.forEach(w => print(`│ ${w.padEnd(48)} │`));
  });
  print(`└${'─'.repeat(50)}┘`);
}

function wrapText(text, width) {
  if (!text) return [''];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  
  words.forEach(word => {
    if ((current + ' ' + word).trim().length <= width) {
      current = (current + ' ' + word).trim();
    } else {
      if (current) lines.push(current);
      current = word.slice(0, width);
    }
  });
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function waitForEnter(message = 'Press [Enter] to continue...') {
  await prompt(`\n${message}`);
}

// ============================================================================
// GitHub API Functions
// ============================================================================

function parsePRUrl(input) {
  // Handle full URL: https://github.com/owner/repo/pull/123
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3] };
  }
  
  // Handle just a number (assumes we're in a git repo)
  if (/^\d+$/.test(input)) {
    try {
      const remote = exec('gh repo view --json nameWithOwner -q .nameWithOwner');
      const [owner, repo] = remote.split('/');
      return { owner, repo, number: input };
    } catch {
      throw new Error('Could not determine repo. Please provide full PR URL.');
    }
  }
  
  throw new Error('Invalid PR URL or number');
}

function fetchPRDetails(owner, repo, number) {
  const query = `
    query {
      repository(owner: "${owner}", name: "${repo}") {
        pullRequest(number: ${number}) {
          title
          body
          author { login }
          state
          additions
          deletions
          changedFiles
          baseRefName
          headRefName
          commits { totalCount }
        }
      }
    }
  `;
  
  const result = exec(`gh api graphql -f query='${query.replace(/\n/g, ' ')}'`);
  const data = JSON.parse(result);
  return data.data.repository.pullRequest;
}

function fetchPRDiff(owner, repo, number) {
  return exec(`gh pr diff ${number} --repo ${owner}/${repo}`);
}

function fetchPRFiles(owner, repo, number) {
  const result = exec(`gh pr view ${number} --repo ${owner}/${repo} --json files -q '.files[].path'`);
  return result.split('\n').filter(Boolean);
}

// ============================================================================
// AI Functions
// ============================================================================

function callAI(systemPrompt, userPrompt) {
  // Write prompts to temp files to handle special characters
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  
  const tmpDir = os.tmpdir();
  const promptFile = path.join(tmpDir, `pr-scout-prompt-${Date.now()}.txt`);
  
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  fs.writeFileSync(promptFile, fullPrompt);
  
  try {
    // Try claude CLI first
    const result = exec(`cat "${promptFile}" | claude --print 2>/dev/null || cat "${promptFile}" | llm 2>/dev/null || echo "AI_ERROR"`, {
      maxBuffer: 50 * 1024 * 1024
    });
    
    if (result === 'AI_ERROR' || !result) {
      // Fallback: return a structured placeholder
      return 'AI analysis unavailable. Please ensure claude CLI or llm is installed.';
    }
    
    return result;
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

function generateSummary(prDetails, diff) {
  const systemPrompt = `You are a code review assistant. Analyze this PR and provide:
1. A 2-3 sentence summary of what this PR does
2. The main purpose/intent
3. Any notable patterns or concerns

Be concise and direct. No fluff.`;

  const userPrompt = `PR Title: ${prDetails.title}

PR Description:
${prDetails.body || '(no description)'}

Author: @${prDetails.author.login}
Changes: +${prDetails.additions} -${prDetails.deletions} across ${prDetails.changedFiles} files
Branch: ${prDetails.headRefName} → ${prDetails.baseRefName}

Diff (first 10000 chars):
${diff.slice(0, 10000)}`;

  return callAI(systemPrompt, userPrompt);
}

function groupFilesByFeature(files, diff, prDetails) {
  const systemPrompt = `You are a code review assistant. Group these files by FEATURE or PURPOSE, not by file type or directory.

Output ONLY valid JSON in this exact format:
{
  "groups": [
    {
      "name": "Feature Name",
      "emoji": "🔧",
      "description": "Brief description of this group",
      "files": ["file1.js", "file2.js"]
    }
  ]
}

Rules:
- Group files that work together for a single feature
- Use descriptive names like "User Authentication" not "Auth Files"
- Include an appropriate emoji for each group
- Every file must be in exactly one group
- Max 5-7 groups, combine smaller ones`;

  const userPrompt = `PR Title: ${prDetails.title}

Files to group:
${files.join('\n')}

Diff context (first 15000 chars):
${diff.slice(0, 15000)}`;

  const response = callAI(systemPrompt, userPrompt);
  
  try {
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.groups;
    }
  } catch (e) {
    // Fallback: single group with all files
  }
  
  return [{
    name: 'All Changes',
    emoji: '📁',
    description: 'All modified files',
    files: files
  }];
}

function explainFileChanges(file, diff, prDetails) {
  // Extract just this file's diff
  const fileDiffRegex = new RegExp(`diff --git a/${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} b/${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=diff --git|$)`);
  const match = diff.match(fileDiffRegex);
  const fileDiff = match ? match[0] : '';
  
  const systemPrompt = `You are a code review assistant. Explain the changes to this file in 3-5 bullet points.
Be specific about WHAT changed and WHY it might have changed.
Focus on the most important changes first.`;

  const userPrompt = `PR: ${prDetails.title}
File: ${file}

Diff:
${fileDiff.slice(0, 8000)}`;

  return callAI(systemPrompt, userPrompt);
}

function generateQuizQuestions(prDetails, diff, groups) {
  const systemPrompt = `You are a code review quiz master. Generate ${CONFIG.quizQuestions} multiple-choice questions to test if a reviewer understood this PR.

Output ONLY valid JSON in this exact format:
{
  "questions": [
    {
      "question": "What is the main purpose of this PR?",
      "options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],
      "correct": "A",
      "explanation": "Brief explanation of why this is correct"
    }
  ]
}

Rules:
- Questions should test understanding, not memorization
- Include questions about: intent, side effects, edge cases
- Make wrong answers plausible but clearly wrong
- Exactly ${CONFIG.quizQuestions} questions`;

  const groupSummary = groups.map(g => `${g.emoji} ${g.name}: ${g.files.join(', ')}`).join('\n');

  const userPrompt = `PR Title: ${prDetails.title}
Description: ${prDetails.body || '(none)'}

Feature Groups:
${groupSummary}

Diff (first 12000 chars):
${diff.slice(0, 12000)}`;

  const response = callAI(systemPrompt, userPrompt);
  
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.questions;
    }
  } catch (e) {
    // Fallback questions
  }
  
  return [{
    question: 'Did you carefully review all the changes in this PR?',
    options: ['A) Yes, I reviewed everything', 'B) No, I skimmed it', 'C) I only looked at some files', 'D) What PR?'],
    correct: 'A',
    explanation: 'A thorough review is essential before approving.'
  }];
}

// ============================================================================
// Interactive Review Flow
// ============================================================================

async function runQuiz(questions) {
  printHeader('📝 QUIZ TIME');
  print('\nAnswer these questions to verify you understood the PR.\n');
  
  let correct = 0;
  
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    print(`\nQuestion ${i + 1}/${questions.length}:`);
    print(`${q.question}\n`);
    q.options.forEach(opt => print(`  ${opt}`));
    
    const answer = (await prompt('\nYour answer (A/B/C/D): ')).toUpperCase();
    
    if (answer === q.correct) {
      print('✅ Correct!');
      correct++;
    } else {
      print(`❌ Wrong. The correct answer was ${q.correct}.`);
    }
    print(`   ${q.explanation}`);
  }
  
  const score = correct / questions.length;
  const passed = score >= CONFIG.passingScore;
  
  printHeader('📊 QUIZ RESULTS');
  print(`\nScore: ${correct}/${questions.length} (${Math.round(score * 100)}%)`);
  print(passed ? '\n✅ PASSED - You may approve this PR' : '\n❌ FAILED - Review the changes again before approving');
  
  return passed;
}

async function walkthrough(groups, diff, prDetails) {
  printHeader('🚶 WALKTHROUGH');
  print('\nLet\'s go through each feature group...\n');
  
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    
    print(`\n${'─'.repeat(52)}`);
    print(`[${i + 1}/${groups.length}] ${group.emoji} ${group.name}`);
    print(`${'─'.repeat(52)}`);
    print(`\n${group.description}\n`);
    print('Files in this group:');
    group.files.forEach(f => print(`  • ${f}`));
    
    const action = await prompt('\n[Enter] Continue | [e] Explain files | [s] Skip group | [q] Quit: ');
    
    if (action.toLowerCase() === 'q') {
      return false;
    }
    
    if (action.toLowerCase() === 's') {
      continue;
    }
    
    if (action.toLowerCase() === 'e' || action === '') {
      for (const file of group.files) {
        print(`\n📄 ${file}`);
        print('─'.repeat(40));
        
        const explanation = explainFileChanges(file, diff, prDetails);
        print(explanation);
        
        if (group.files.indexOf(file) < group.files.length - 1) {
          const next = await prompt('\n[Enter] Next file | [s] Skip to next group: ');
          if (next.toLowerCase() === 's') break;
        }
      }
    }
  }
  
  return true;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    print(`
🔍 pr-scout - AI-Powered PR Review

Usage:
  pr-scout <pr-url-or-number> [options]

Options:
  --no-quiz     Skip the quiz (just review)
  --model NAME  Use a different AI model
  --help, -h    Show this help

Examples:
  pr-scout https://github.com/owner/repo/pull/123
  pr-scout 123
  pr-scout 123 --no-quiz
`);
    process.exit(0);
  }
  
  const prInput = args.find(a => !a.startsWith('--'));
  const skipQuiz = args.includes('--no-quiz');
  
  print('\n🔍 PR Scout - AI-Powered Review\n');
  
  // Parse PR URL
  let pr;
  try {
    pr = parsePRUrl(prInput);
  } catch (err) {
    print(`❌ ${err.message}`);
    process.exit(1);
  }
  
  print(`📋 Fetching PR #${pr.number} from ${pr.owner}/${pr.repo}...`);
  
  // Fetch PR data
  let prDetails, diff, files;
  try {
    prDetails = fetchPRDetails(pr.owner, pr.repo, pr.number);
    diff = fetchPRDiff(pr.owner, pr.repo, pr.number);
    files = fetchPRFiles(pr.owner, pr.repo, pr.number);
  } catch (err) {
    print(`❌ Failed to fetch PR: ${err.message}`);
    print('Make sure gh CLI is installed and authenticated.');
    process.exit(1);
  }
  
  // Show summary
  printHeader('📝 PR SUMMARY');
  print(`\nTitle: ${prDetails.title}`);
  print(`Author: @${prDetails.author.login}`);
  print(`Changes: +${prDetails.additions} -${prDetails.deletions} across ${prDetails.changedFiles} files`);
  print(`Commits: ${prDetails.commits.totalCount}`);
  print(`Branch: ${prDetails.headRefName} → ${prDetails.baseRefName}`);
  
  print('\n🤖 Generating AI summary...');
  const summary = generateSummary(prDetails, diff);
  print(`\n${summary}`);
  
  // Group files by feature
  print('\n🗂️  Grouping files by feature...');
  const groups = groupFilesByFeature(files, diff, prDetails);
  
  printHeader('📁 FEATURE GROUPS');
  groups.forEach((group, i) => {
    print(`\n[${i + 1}] ${group.emoji} ${group.name} (${group.files.length} files)`);
    print(`    ${group.description}`);
    group.files.forEach(f => print(`    • ${f}`));
  });
  
  await waitForEnter('\nPress [Enter] to start walkthrough...');
  
  // Interactive walkthrough
  const completed = await walkthrough(groups, diff, prDetails);
  
  if (!completed) {
    print('\n👋 Review cancelled.\n');
    process.exit(0);
  }
  
  // Quiz mode
  if (!skipQuiz) {
    print('\n🎯 Generating quiz questions...');
    const questions = generateQuizQuestions(prDetails, diff, groups);
    
    await waitForEnter('\nReady for the quiz? Press [Enter] to begin...');
    
    const passed = await runQuiz(questions);
    
    if (passed) {
      const approve = await prompt('\n🚀 Approve this PR? (y/n): ');
      if (approve.toLowerCase() === 'y') {
        print('\n✅ Approving PR...');
        try {
          exec(`gh pr review ${pr.number} --repo ${pr.owner}/${pr.repo} --approve`);
          print('PR approved! 🎉\n');
        } catch (err) {
          print(`❌ Failed to approve: ${err.message}\n`);
        }
      } else {
        print('\n👍 PR not approved. You can review again later.\n');
      }
    } else {
      print('\n📚 Please review the changes again before approving.\n');
    }
  } else {
    print('\n✅ Review complete (quiz skipped).\n');
    const approve = await prompt('🚀 Approve this PR? (y/n): ');
    if (approve.toLowerCase() === 'y') {
      try {
        exec(`gh pr review ${pr.number} --repo ${pr.owner}/${pr.repo} --approve`);
        print('PR approved! 🎉\n');
      } catch (err) {
        print(`❌ Failed to approve: ${err.message}\n`);
      }
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
