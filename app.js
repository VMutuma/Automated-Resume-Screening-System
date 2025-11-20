// ============================================
// AUTOMATED RESUME SCREENING SYSTEM
// Google Apps Script Implementation
// ============================================

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Google Sheet IDs
  SHEET_ID: 'YOUR_SHEET_ID_HERE',
  
  // API Keys (Store in Script Properties for security)
  GEMINI_API_KEY: PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'),
  OPENAI_API_KEY: PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY'),
  ANTHROPIC_API_KEY: PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'),
  
  // Slack Webhooks
  SLACK_WEBHOOK_URGENT: PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URGENT'),
  SLACK_WEBHOOK_DAILY: PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_DAILY'),
  SLACK_WEBHOOK_ALERTS: PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_ALERTS'),
  
  // Google Drive Folder IDs
  DRIVE_FOLDER_ACTIVE: 'YOUR_DRIVE_FOLDER_ID_HERE',
  
  // Gmail Settings
  GMAIL_LABEL: 'recruiting', 
  SEARCH_QUERY: 'label:recruiting is:unread has:attachment',
  
  // Scoring Thresholds
  HIGH_SCORE_THRESHOLD: 80,
  MEDIUM_SCORE_THRESHOLD: 65,
  LOW_CONFIDENCE_THRESHOLD: 0.70,
  
  // System Settings
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000,
  DATA_RETENTION_DAYS: 90
};

// MAIN PROCESSING FUNCTION
function processNewResumes() {
  try {
    Logger.log('Starting resume processing...');
    
    // Get unread emails with attachments
    const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 50);
    Logger.log(`Found ${threads.length} threads to process`);
    
    if (threads.length === 0) {
      Logger.log('No new resumes to process');
      return;
    }
    
    let successCount = 0;
    let errorCount = 0;
    
    // Process each email thread
    for (const thread of threads) {
      const messages = thread.getMessages();
      
      for (const message of messages) {
        try {
          if (message.isUnread() && message.getAttachments().length > 0) {
            processEmail(message);
            successCount++;
            message.markRead();
            message.getThread().addLabel(GmailApp.getUserLabelByName('Processed'));
          }
        } catch (error) {
          Logger.log(`Error processing email: ${error.message}`);
          errorCount++;
          logError('EMAIL_PROCESSING_ERROR', null, error.message, message.getId());
        }
      }
    }
    
    Logger.log(`Processing complete. Success: ${successCount}, Errors: ${errorCount}`);
    
    // Send summary if there were any errors
    if (errorCount > 0) {
      sendSlackAlert('ERROR', `Processed ${successCount} resumes with ${errorCount} errors`);
    }
    
  } catch (error) {
    Logger.log(`Fatal error in processNewResumes: ${error.message}`);
    sendSlackAlert('CRITICAL', `Fatal error: ${error.message}`);
  }
}

// EMAIL PROCESSING
function processEmail(message) {
  const startTime = new Date().getTime();
  
  // Extract metadata
  const metadata = extractEmailMetadata(message);
  Logger.log(`Processing email from: ${metadata.senderEmail}`);
  
  // Find matching Job Description
  const jobMatch = matchJobDescription(metadata.subject, metadata.body);
  if (!jobMatch) {
    Logger.log('No matching JD found, using default');
    // Could skip processing or use default JD
  }
  
  // Check for duplicate candidate
  const emailHash = hashString(metadata.senderEmail);
  const existingCandidate = checkDuplicate(emailHash);
  
  if (existingCandidate) {
    Logger.log(`Duplicate candidate detected: ${existingCandidate.candidate_id}`);
    updateDuplicateRecord(existingCandidate.candidate_id, metadata);
    return;
  }
  
  // Generate candidate ID
  const candidateId = generateCandidateId();
  
  // Process attachments
  const attachments = message.getAttachments();
  let resumeText = null;
  let resumeUrl = null;
  
  for (const attachment of attachments) {
    if (isResumeFile(attachment.getName())) {
      // Save to Drive
      resumeUrl = saveResumeToDrive(attachment, candidateId);
      
      // Extract text
      resumeText = extractTextFromFile(attachment);
      break;
    }
  }
  
  if (!resumeText) {
    Logger.log('No valid resume found in attachments');
    logError('NO_RESUME_FOUND', candidateId, 'No valid resume attachment', message.getId());
    return;
  }
  
  // Extract and anonymize PII
  const { pii, anonymizedResume } = extractAndAnonymizePII(resumeText, metadata);
  
  // Store PII separately
  storePII(candidateId, pii);
  
  // Get Job Description
  const jdText = jobMatch ? jobMatch.jd_text : getDefaultJD();
  const scoringCriteria = jobMatch ? jobMatch.scoring_criteria : getDefaultScoringCriteria();
  
  // Score with LLMs
  const scoringResult = scoreResumeWithLLMs(anonymizedResume, jdText, scoringCriteria, candidateId);
  
  // Save to main candidates sheet
  saveCandidateData(candidateId, metadata, jobMatch, scoringResult, resumeUrl, emailHash);
  
  // Log processing
  const processingTime = new Date().getTime() - startTime;
  logProcessing(candidateId, message.getId(), scoringResult.llm_used, processingTime, scoringResult.api_cost);
  
  // Send notification if high score
  if (scoringResult.overall_score >= CONFIG.HIGH_SCORE_THRESHOLD) {
    sendHighScoreNotification(candidateId, scoringResult, jobMatch);
  }
  
  Logger.log(`Successfully processed candidate: ${candidateId} (Score: ${scoringResult.overall_score})`);
}

// ============================================
// METADATA EXTRACTION
// ============================================

function extractEmailMetadata(message) {
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const senderEmail = message.getFrom().match(/<(.+)>/)?.[1] || message.getFrom();
  const senderName = message.getFrom().split('<')[0].trim();
  const receivedDate = message.getDate();
  
  // Try to extract source from subject/body
  let source = 'Email';
  if (subject.toLowerCase().includes('linkedin')) source = 'LinkedIn';
  else if (subject.toLowerCase().includes('indeed')) source = 'Indeed';
  else if (body.toLowerCase().includes('via linkedin')) source = 'LinkedIn';
  
  return {
    subject,
    body,
    senderEmail,
    senderName,
    receivedDate,
    source,
    messageId: message.getId()
  };
}

// ============================================
// JOB DESCRIPTION MATCHING
// ============================================

function matchJobDescription(subject, body) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('JOB_DESCRIPTIONS');
  const data = sheet.getDataRange().getValues();
  
  // Skip header row
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const jobId = row[0];
    const roleTitle = row[1];
    const status = row[3];
    
    // Skip closed jobs
    if (status === 'Closed') continue;
    
    // Check if role title appears in subject or body
    const searchText = (subject + ' ' + body).toLowerCase();
    const roleTitleLower = roleTitle.toLowerCase();
    
    if (searchText.includes(roleTitleLower)) {
      return {
        job_id: jobId,
        role_title: roleTitle,
        jd_text: row[4],
        required_skills: row[5],
        preferred_skills: row[6],
        min_experience_years: row[7],
        education_requirement: row[8],
        scoring_criteria: parseScoringWeights(row[9])
      };
    }
  }
  
  // No match found
  return null;
}

function parseScoringWeights(weightsJson) {
  try {
    return JSON.parse(weightsJson || '{}');
  } catch {
    return getDefaultScoringCriteria();
  }
}

function getDefaultScoringCriteria() {
  return {
    skills: 40,
    experience: 30,
    education: 15,
    additional: 15
  };
}

function getDefaultJD() {
  return "General technical position requiring strong problem-solving skills and relevant experience.";
}

// ============================================
// DUPLICATE DETECTION
// ============================================

function checkDuplicate(emailHash) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES');
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === emailHash) { // Column B: email_hash
      return {
        candidate_id: data[i][0],
        row: i + 1
      };
    }
  }
  
  return null;
}

function updateDuplicateRecord(candidateId, metadata) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES');
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === candidateId) {
      // Update submission date and add note
      const notesCol = 25; // Adjust based on actual column
      const currentNotes = data[i][notesCol] || '';
      const newNote = `Re-applied on ${metadata.receivedDate.toISOString().split('T')[0]}`;
      sheet.getRange(i + 1, notesCol + 1).setValue(currentNotes + '\n' + newNote);
      
      Logger.log(`Updated duplicate record: ${candidateId}`);
      break;
    }
  }
}

// ============================================
// PII EXTRACTION & ANONYMIZATION
// ============================================

function extractAndAnonymizePII(resumeText, metadata) {
  // Extract PII
  const pii = {
    full_name: metadata.senderName || extractNameFromResume(resumeText),
    email: metadata.senderEmail,
    phone: extractPhone(resumeText),
    address: extractAddress(resumeText),
    linkedin_url: extractLinkedIn(resumeText)
  };
  
  // Create anonymized version
  let anonymizedResume = resumeText;
  
  if (pii.full_name) {
    anonymizedResume = anonymizedResume.replace(new RegExp(pii.full_name, 'gi'), 'CANDIDATE_NAME');
  }
  if (pii.email) {
    anonymizedResume = anonymizedResume.replace(new RegExp(pii.email, 'gi'), 'EMAIL_REDACTED');
  }
  if (pii.phone) {
    anonymizedResume = anonymizedResume.replace(new RegExp(escapeRegex(pii.phone), 'g'), 'PHONE_REDACTED');
  }
  if (pii.address) {
    anonymizedResume = anonymizedResume.replace(new RegExp(escapeRegex(pii.address), 'gi'), 'LOCATION_REDACTED');
  }
  
  return { pii, anonymizedResume };
}

function extractNameFromResume(text) {
  // Simple heuristic: first line is often the name
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length < 50 && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(firstLine)) {
      return firstLine;
    }
  }
  return null;
}

function extractPhone(text) {
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
  const match = text.match(phoneRegex);
  return match ? match[0] : null;
}

function extractAddress(text) {
  // Simple heuristic: look for city, state patterns
  const addressRegex = /\d+\s+[A-Za-z\s]+,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5}/;
  const match = text.match(addressRegex);
  return match ? match[0] : null;
}

function extractLinkedIn(text) {
  const linkedinRegex = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/;
  const match = text.match(linkedinRegex);
  return match ? match[0] : null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// FILE HANDLING
// ============================================

function isResumeFile(filename) {
  const validExtensions = ['.pdf', '.docx', '.doc', '.txt'];
  return validExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

function saveResumeToDrive(attachment, candidateId) {
  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ACTIVE);
  const fileName = `${candidateId}_${attachment.getName()}`;
  const file = folder.createFile(attachment.copyBlob().setName(fileName));
  return file.getUrl();
}

function extractTextFromFile(attachment) {
  const contentType = attachment.getContentType();
  const fileName = attachment.getName();
  
  // For PDFs, convert to base64 and use LLM to extract
  if (contentType === 'application/pdf' || fileName.endsWith('.pdf')) {
    return extractTextFromPDF(attachment);
  }
  
  // For DOCX, extract as text
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
    return extractTextFromDOCX(attachment);
  }
  
  // For plain text
  if (contentType === 'text/plain' || fileName.endsWith('.txt')) {
    return attachment.getDataAsString();
  }
  
  return null;
}

function extractTextFromPDF(attachment) {
  // Use Claude API to extract text from PDF (Claude can handle PDFs directly)
  try {
    const base64Data = Utilities.base64Encode(attachment.getBytes());
    
    const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64Data
              }
            },
            {
              type: "text",
              text: "Extract all text from this resume/CV. Return only the extracted text, no commentary."
            }
          ]
        }]
      })
    });
    
    const data = JSON.parse(response.getContentText());
    return data.content[0].text;
  } catch (error) {
    Logger.log(`Error extracting PDF text: ${error.message}`);
    return null;
  }
}

function extractTextFromDOCX(attachment) {
  // DOCX extraction is complex, for now use simple text extraction
  // In production, you'd use a library or service
  return attachment.getDataAsString(); // This won't work perfectly for DOCX
}

// ============================================
// LLM SCORING
// ============================================

function scoreResumeWithLLMs(anonymizedResume, jdText, scoringCriteria, candidateId) {
  let result = null;
  let attempts = [];
  
  // PRIMARY: Gemini 2.0 Flash
  try {
    result = callGemini(anonymizedResume, jdText, scoringCriteria);
    attempts.push({ llm: 'gemini-2.0-flash', success: true, confidence: result.confidence_level });
    
    // If low confidence, escalate to Claude
    if (result.confidence_level < CONFIG.LOW_CONFIDENCE_THRESHOLD) {
      Logger.log('Low confidence from Gemini, escalating to Claude');
      result = callClaude(anonymizedResume, jdText, scoringCriteria);
      attempts.push({ llm: 'claude-sonnet-4', success: true });
    }
    
  } catch (geminiError) {
    Logger.log(`Gemini failed: ${geminiError.message}`);
    attempts.push({ llm: 'gemini-2.0-flash', success: false, error: geminiError.message });
    
    // SECONDARY: GPT-4o-mini
    try {
      result = callGPT(anonymizedResume, jdText, scoringCriteria);
      attempts.push({ llm: 'gpt-4o-mini', success: true });
      
    } catch (gptError) {
      Logger.log(`GPT failed: ${gptError.message}`);
      attempts.push({ llm: 'gpt-4o-mini', success: false, error: gptError.message });
      
      // TERTIARY: Claude
      try {
        result = callClaude(anonymizedResume, jdText, scoringCriteria);
        attempts.push({ llm: 'claude-sonnet-4', success: true });
        
      } catch (claudeError) {
        Logger.log('All LLMs failed');
        attempts.push({ llm: 'claude-sonnet-4', success: false, error: claudeError.message });
        
        logError('ALL_LLMS_FAILED', candidateId, JSON.stringify(attempts));
        sendSlackAlert('CRITICAL', `All LLMs failed for candidate ${candidateId}`);
        throw new Error('All LLM processing failed');
      }
    }
  }
  
  return result;
}

function buildPrompt(anonymizedResume, jdText, scoringCriteria) {
  return `You are an expert technical recruiter evaluating a candidate's resume.

JOB DESCRIPTION:
${jdText}

CANDIDATE RESUME (ANONYMIZED):
${anonymizedResume}

SCORING CRITERIA:
- Skills Match: ${scoringCriteria.skills || 45}% weight
- Experience: ${scoringCriteria.experience || 30}% weight
- Education: ${scoringCriteria.education || 15}% weight
- Additional Factors: ${scoringCriteria.additional || 10}% weight

IMPORTANT - BIAS PREVENTION:
- Candidate's personal identifiers have been redacted for fairness
- Evaluate ONLY based on skills, experience, and qualifications
- Do NOT consider: name, gender, ethnicity, age, university prestige
- Focus on: technical abilities, relevant experience, demonstrated achievements

OUTPUT FORMAT (respond ONLY with valid JSON, no markdown backticks):
{
  "skills_extracted": ["skill1", "skill2"],
  "experience_years": 5.5,
  "experience_details": [
    {"role": "Senior Developer", "company": "COMPANY_A", "duration_years": 3, "key_achievements": ["achievement1"]}
  ],
  "education": [
    {"degree": "BS Computer Science", "institution": "UNIVERSITY_A", "year": 2018}
  ],
  "certifications": ["AWS Certified"],
  "skills_match_score": 85,
  "experience_match_score": 80,
  "education_score": 75,
  "additional_score": 70,
  "overall_score": 82,
  "reasoning": "Detailed explanation of scoring in 2-3 sentences",
  "red_flags": ["6-month employment gap in 2022"],
  "confidence_level": 0.89
}`;
}

function callGemini(resume, jd, criteria) {
  const prompt = buildPrompt(resume, jd, criteria);
  
  const response = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": CONFIG.GEMINI_API_KEY
    },
    payload: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2000,
        responseMimeType: "application/json"
      }
    }),
    muteHttpExceptions: true
  });
  
  const data = JSON.parse(response.getContentText());
  if (data.error) throw new Error(data.error.message);
  
  const resultText = data.candidates[0].content.parts[0].text;
  const result = JSON.parse(resultText);
  result.llm_used = 'gemini-2.0-flash';
  result.api_cost = estimateGeminiCost(prompt, resultText);
  
  return result;
}

function callGPT(resume, jd, criteria) {
  const prompt = buildPrompt(resume, jd, criteria);
  
  const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.OPENAI_API_KEY
    },
    payload: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an expert technical recruiter. Respond only with valid JSON." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 2000
    }),
    muteHttpExceptions: true
  });
  
  const data = JSON.parse(response.getContentText());
  if (data.error) throw new Error(data.error.message);
  
  const resultText = data.choices[0].message.content;
  const result = JSON.parse(resultText);
  result.llm_used = 'gpt-4o-mini';
  result.api_cost = estimateGPTCost(prompt, resultText);
  
  return result;
}

function callClaude(resume, jd, criteria) {
  const prompt = buildPrompt(resume, jd, criteria);
  
  const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }]
    }),
    muteHttpExceptions: true
  });
  
  const data = JSON.parse(response.getContentText());
  if (data.error) throw new Error(data.error.message);
  
  const resultText = data.content[0].text;
  const cleanJson = resultText.replace(/```json|```/g, '').trim();
  const result = JSON.parse(cleanJson);
  result.llm_used = 'claude-sonnet-4';
  result.api_cost = estimateClaudeCost(prompt, resultText);
  
  return result;
}

// ============================================
// COST ESTIMATION
// ============================================

function estimateGeminiCost(prompt, response) {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  return (inputTokens * 0.00000001875) + (outputTokens * 0.000000075);
}

function estimateGPTCost(prompt, response) {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  return (inputTokens * 0.00000015) + (outputTokens * 0.0000006);
}

function estimateClaudeCost(prompt, response) {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  return (inputTokens * 0.000003) + (outputTokens * 0.000015);
}

// ============================================
// DATA STORAGE
// ============================================

function storePII(candidateId, pii) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES_PII');
  
  sheet.appendRow([
    candidateId,
    pii.full_name || '',
    pii.email || '',
    pii.phone || '',
    pii.address || '',
    pii.linkedin_url || '',
    '', // portfolio_url
    'TRUE', // data_consent
    new Date(Date.now() + CONFIG.DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000) // retention_until
  ]);
}

function saveCandidateData(candidateId, metadata, jobMatch, scoringResult, resumeUrl, emailHash) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES');
  
  const phoneHash = scoringResult.phone ? hashString(scoringResult.phone) : '';
  
  sheet.appendRow([
    candidateId,
    emailHash,
    phoneHash,
    jobMatch ? jobMatch.job_id : 'UNMATCHED',
    metadata.source,
    metadata.receivedDate,
    resumeUrl,
    scoringResult.skills_extracted.join(', '),
    scoringResult.experience_years,
    JSON.stringify(scoringResult.experience_details),
    JSON.stringify(scoringResult.education),
    scoringResult.certifications.join(', '),
    scoringResult.overall_score,
    scoringResult.skills_match_score,
    scoringResult.experience_match_score,
    scoringResult.education_score,
    scoringResult.additional_score || 0,
    scoringResult.red_flags.join('; '),
    scoringResult.reasoning,
    scoringResult.llm_used,
    scoringResult.confidence_level,
    'Processed',
    '', // hr_rating
    '', // hr_notes
    'Not Contacted',
    new Date()
  ]);
}

// ============================================
// LOGGING
// ============================================

function logProcessing(candidateId, emailId, llmUsed, processingTime, apiCost) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('PROCESSING_LOG');
  
  sheet.appendRow([
    `LOG_${new Date().getTime()}`,
    new Date(),
    emailId,
    candidateId,
    'Resume Processed',
    llmUsed,
    processingTime,
    Math.ceil(processingTime / 4), // rough token estimate
    apiCost,
    'Success'
  ]);
}

function logError(errorType, candidateId, errorMessage, emailId = '') {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('ERROR_LOG');
  
  sheet.appendRow([
    `ERR_${new Date().getTime()}`,
    new Date(),
    errorType,
    emailId,
    candidateId || '',
    errorMessage,
    '', // stack_trace
    0, // retry_count
    'Pending',
    'FALSE' // slack_notified
  ]);
}

// ============================================
// NOTIFICATIONS
// ============================================

function sendHighScoreNotification(candidateId, scoringResult, jobMatch) {
  const webhook = CONFIG.SLACK_WEBHOOK_URGENT;
  if (!webhook) return;
  
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}`;
  const jobTitle = jobMatch ? jobMatch.role_title : 'General Position';
  
  const message = {
    text: "🌟 High-Quality Candidate Detected!",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🌟 Excellent Candidate Match"
        }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Score:*\n${scoringResult.overall_score}/100` },
          { type: "mrkdwn", text: `*Role:*\n${jobTitle}` },
          { type: "mrkdwn", text: `*Experience:*\n${scoringResult.experience_years} years` },
          { type: "mrkdwn", text: `*Top Skills:*\n${scoringResult.skills_extracted.slice(0, 3).join(', ')}` }
        ]
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Reasoning:* ${scoringResult.reasoning.substring(0, 200)}...`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View in Sheet" },
            url: sheetUrl,
            style: "primary"
          }
        ]
      }
    ]
  };
  
  UrlFetchApp.fetch(webhook, {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(message)
  });
}

function sendSlackAlert(level, message) {
  const webhook = CONFIG.SLACK_WEBHOOK_ALERTS;
  if (!webhook) return;
  
  const emoji = level === 'CRITICAL' ? '🚨' : '⚠️';
  
  const payload = {
    text: `${emoji} ${level}: ${message}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${level}*\n${message}`
        }
      }
    ]
  };
  
  UrlFetchApp.fetch(webhook, {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(payload)
  });
}

// ============================================
// DAILY DIGEST
// Triggered at 8am daily
// ============================================

function sendDailyDigest() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const stats = getStatsForDateRange(yesterday, today);
  
  if (stats.total === 0) {
    Logger.log('No resumes processed yesterday, skipping digest');
    return;
  }
  
  const webhook = CONFIG.SLACK_WEBHOOK_DAILY;
  if (!webhook) return;
  
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}`;
  
  const message = {
    text: "📊 Daily Recruiting Summary",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `📊 Recruiting Summary - ${formatDate(yesterday)}`
        }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Total Resumes:*\n${stats.total}` },
          { type: "mrkdwn", text: `*High Quality (≥80):*\n${stats.high_quality}` },
          { type: "mrkdwn", text: `*Medium (65-79):*\n${stats.medium_quality}` },
          { type: "mrkdwn", text: `*Low (<65):*\n${stats.low_quality}` }
        ]
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Top 3 Candidates:*\n${formatTopCandidates(stats.top_candidates)}`
        }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Avg Score:*\n${stats.avg_score}` },
          { type: "mrkdwn", text: `*Processing Success:*\n${stats.success_rate}%` },
          { type: "mrkdwn", text: `*API Cost:*\n${stats.api_cost.toFixed(3)}` },
          { type: "mrkdwn", text: `*Errors:*\n${stats.error_count}` }
        ]
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open Dashboard" },
            url: sheetUrl,
            style: "primary"
          }
        ]
      }
    ]
  };
  
  UrlFetchApp.fetch(webhook, {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(message)
  });
}

function getStatsForDateRange(startDate, endDate) {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES');
  const data = sheet.getDataRange().getValues();
  
  let total = 0;
  let highQuality = 0;
  let mediumQuality = 0;
  let lowQuality = 0;
  let totalScore = 0;
  let topCandidates = [];
  
  for (let i = 1; i < data.length; i++) {
    const submissionDate = new Date(data[i][5]); // Column F: submission_date
    
    if (submissionDate >= startDate && submissionDate < endDate) {
      total++;
      const score = data[i][12]; // Column M: overall_score
      totalScore += score;
      
      if (score >= 80) highQuality++;
      else if (score >= 65) mediumQuality++;
      else lowQuality++;
      
      topCandidates.push({
        id: data[i][0],
        score: score,
        role: data[i][3],
        skills: data[i][7]
      });
    }
  }
  
  // Sort and get top 3
  topCandidates.sort((a, b) => b.score - a.score);
  topCandidates = topCandidates.slice(0, 3);
  
  // Get processing stats
  const logSheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('PROCESSING_LOG');
  const logData = logSheet.getDataRange().getValues();
  
  let apiCost = 0;
  let successCount = 0;
  
  for (let i = 1; i < logData.length; i++) {
    const logDate = new Date(logData[i][1]);
    if (logDate >= startDate && logDate < endDate) {
      apiCost += logData[i][8] || 0;
      if (logData[i][9] === 'Success') successCount++;
    }
  }
  
  // Get error count
  const errorSheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('ERROR_LOG');
  const errorData = errorSheet.getDataRange().getValues();
  
  let errorCount = 0;
  for (let i = 1; i < errorData.length; i++) {
    const errorDate = new Date(errorData[i][1]);
    if (errorDate >= startDate && errorDate < endDate) {
      errorCount++;
    }
  }
  
  return {
    total,
    high_quality: highQuality,
    medium_quality: mediumQuality,
    low_quality: lowQuality,
    avg_score: total > 0 ? Math.round(totalScore / total) : 0,
    top_candidates: topCandidates,
    api_cost: apiCost,
    success_rate: total > 0 ? Math.round((successCount / total) * 100) : 0,
    error_count: errorCount
  };
}

function formatTopCandidates(candidates) {
  if (candidates.length === 0) return 'None';
  
  return candidates.map((c, i) => 
    `${i + 1}. ${c.id} - ${c.score}/100 - ${c.role || 'General'}`
  ).join('\n');
}

function formatDate(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

// ============================================
// DATA CLEANUP
// Runs daily to delete old resumes
// ============================================

function cleanupOldResumes() {
  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ACTIVE);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.DATA_RETENTION_DAYS);
  
  const files = folder.getFiles();
  let deletedCount = 0;
  
  while (files.hasNext()) {
    const file = files.next();
    if (file.getDateCreated() < cutoffDate) {
      const fileName = file.getName();
      file.setTrashed(true);
      deletedCount++;
      Logger.log(`Deleted old resume: ${fileName}`);
    }
  }
  
  if (deletedCount > 0) {
    Logger.log(`Cleanup complete: ${deletedCount} files deleted`);
    sendSlackAlert('INFO', `Cleanup: ${deletedCount} resumes older than ${CONFIG.DATA_RETENTION_DAYS} days deleted`);
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function generateCandidateId() {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `CAND_${dateStr}_${random}`;
}

function hashString(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str)
    .map(byte => ('0' + (byte & 0xFF).toString(16)).slice(-2))
    .join('')
    .substring(0, 16);
}

// ============================================
// CUSTOM MENU
// Shows when sheet is opened
// ============================================

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Recruiting System')
    .addItem('Process New Resumes Now', 'processNewResumes')
    .addItem('Send Daily Digest', 'sendDailyDigest')
    .addItem('Cleanup Old Resumes', 'cleanupOldResumes')
    .addSeparator()
    .addItem('Setup Triggers', 'setupTriggers')
    .addItem('View API Keys', 'showApiKeysDialog')
    .addToUi();
}

// ============================================
// SETUP & CONFIGURATION
// ============================================

function setupTriggers() {
  // Delete existing triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  
  // Process resumes every 15 minutes
  ScriptApp.newTrigger('processNewResumes')
    .timeBased()
    .everyMinutes(15)
    .create();
  
  // Daily digest at 8am
  ScriptApp.newTrigger('sendDailyDigest')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();
  
  // Cleanup old resumes daily at 2am
  ScriptApp.newTrigger('cleanupOldResumes')
    .timeBased()
    .atHour(2)
    .everyDays(1)
    .create();
  
  Logger.log('Triggers setup complete');
  SpreadsheetApp.getUi().alert('Triggers created successfully!\n\n- Process resumes: Every 15 minutes\n- Daily digest: 8am daily\n- Cleanup: 2am daily');
}

function showApiKeysDialog() {
  const gemini = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || 'Not set';
  const openai = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY') || 'Not set';
  const anthropic = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || 'Not set';
  
  const html = `
    <p><strong>Current API Keys:</strong></p>
    <ul>
      <li>Gemini: ${gemini.substring(0, 8)}...</li>
      <li>OpenAI: ${openai.substring(0, 8)}...</li>
      <li>Anthropic: ${anthropic.substring(0, 8)}...</li>
    </ul>
    <p>To update, go to: Extensions > Apps Script > Project Settings > Script Properties</p>
  `;
  
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(400).setHeight(200),
    'API Keys Status'
  );
}

// ============================================
// INITIAL SETUP HELPER
// Run this once after creating the sheet
// ============================================

function initializeSystem() {
  // Create Gmail labels if they don't exist
  try {
    GmailApp.getUserLabelByName('recruiting') || GmailApp.createLabel('recruiting');
    GmailApp.getUserLabelByName('Processed') || GmailApp.createLabel('Processed');
  } catch (e) {
    Logger.log('Gmail labels already exist or error creating: ' + e);
  }
  
  // Setup triggers
  setupTriggers();
  
  SpreadsheetApp.getUi().alert('System initialized!\n\nNext steps:\n1. Set API keys in Script Properties\n2. Configure Slack webhooks\n3. Update CONFIG with your Sheet ID and Drive Folder ID\n4. Test with a sample email');
}