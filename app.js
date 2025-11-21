const CONFIG = {
  SHEET_ID: '',

  // API Keys
  GEMINI_API_KEY: PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'),
  OPENAI_API_KEY: PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY'),
  ANTHROPIC_API_KEY: PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'),

  // Slack webhooks
  SLACK_WEBHOOK_URGENT: PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URGENT'),
  SLACK_WEBHOOK_DAILY: PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_DAILY'),
  SLACK_WEBHOOK_ALERTS: PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_ALERTS'),

  // G Drive
  DRIVE_FOLDER_ACTIVE: '',

  // Gmail Settings
  GMAIL_LABEL: 'recruiting', 
  SEARCH_QUERY: 'label:recruiting is:unread has:attachment',
  
  // Scoring Thresholds
  HIGH_SCORE_THRESHOLD: 75,
  MEDIUM_SCORE_THRESHOLD: 65,
  LOW_CONFIDENCE_THRESHOLD: 0.70,
  
  // System Settings
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000,
  DATA_RETENTION_DAYS: 90,
  
  COVER_LETTER_KEYWORDS: ['cover letter', 'coverletter', 'application letter', 'letter'],
  
  SKILL_VARIATIONS: {
    'javascript': ['js', 'javascript', 'ecmascript', 'node.js', 'nodejs'],
    'python': ['python', 'python3', 'py'],
    'react': ['react', 'reactjs', 'react.js'],
    'angular': ['angular', 'angularjs', 'angular.js'],
    'vue': ['vue', 'vuejs', 'vue.js'],
    'aws': ['aws', 'amazon web services'],
    'gcp': ['gcp', 'google cloud platform', 'google cloud'],
    'docker': ['docker', 'containerization'],
    'kubernetes': ['kubernetes', 'k8s'],
    'sql': ['sql', 'mysql', 'postgresql', 'postgres'],
    'nosql': ['nosql', 'mongodb', 'cassandra', 'dynamodb']
  }
}

// MAIN PROCESSING FUNCTION
function processNewResumes(){
  try{
    Logger.log('Starting resume processing...');

    const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 50);
    Logger.log(`Found ${threads.length} threads to process`);

    if (threads.length === 0){
      Logger.log('No new resumes to process');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const thread of threads) {
      try {
        const messages = thread.getMessages();

        for (const message of messages) {
          try {
            if (message.isUnread() && message.getAttachments().length > 0) {
              processEmail(message);
              successCount++;

              message.markRead();
              thread.addLabel(GmailApp.getUserLabelByName('Processed'));
            }
          } catch (error) {
            Logger.log(`Error processing email: ${error.message}`);
            Logger.log(`Stack trace: ${error.stack}`);
            errorCount++;
            logError('EMAIL_PROCESSING_ERROR', null, error.message, message.getId());
          }
        }
      } catch (error) {
        Logger.log(`Error processing thread: ${error.message}`);
        errorCount++;
      }
    }

    Logger.log(`Processing complete. Success: ${successCount}, Errors: ${errorCount}`);

    if (errorCount > 0) {
      sendSlackAlert('ERROR', `Processed ${successCount} resumes with ${errorCount} errors`);
    }

  } catch (error) {
    Logger.log(`Fatal error in processNewResumes: ${error.message}`);
    Logger.log(`Stack trace: ${error.stack}`);
    sendSlackAlert('CRITICAL', `Fatal error: ${error.message}`);
  }
}

// EMAIL PROCESSING
function processEmail(message) {
  const startTime = new Date().getTime();

  const metadata = extractEmailMetadata(message);
  Logger.log(`Processing email from: ${metadata.senderEmail}`);

  const jobMatch = matchJobDescription(metadata.subject, metadata.body);
  if(!jobMatch) {
    Logger.log('No matching JD found, using default');
  }

  const emailHash = hashString(metadata.senderEmail);
  const existingCandidate = checkDuplicate(emailHash);

  if(existingCandidate) {
    Logger.log(`Duplicate candidate detected: ${existingCandidate.candidate_id}`);
    updateDuplicateRecord(existingCandidate.candidate_id, metadata);
    return;
  }

  const candidateId = generateCandidateId();
  
  // NEW: Process all attachments to find resumes and cover letters
  const attachmentResults = processAllAttachments(message.getAttachments(), candidateId);
  
  if (!attachmentResults.resumeText) {
    Logger.log('No valid resume found in attachments');
    logError('NO_RESUME_FOUND', candidateId, 'No valid resume attachment', message.getId());
    
    // Still save the candidate record with partial data
    saveCandidateWithoutResume(candidateId, metadata, emailHash);
    return;
  }

  // Extract and anonymize PII with improved regex escaping
  const { pii, anonymizedResume } = extractAndAnonymizePII(
    attachmentResults.resumeText, 
    metadata,
    attachmentResults.coverLetterText
  );
  
  storePII(candidateId, pii);

  const jdText = jobMatch ? jobMatch.jd_text : getDefaultJD();
  const scoringCriteria = jobMatch ? jobMatch.scoring_criteria : getDefaultScoringCriteria();

  let scoringResult;
  try {
    scoringResult = scoreResumeWithLLMs(
      anonymizedResume, 
      jdText, 
      scoringCriteria, 
      candidateId,
      attachmentResults.coverLetterText
    );
  } catch (scoringError) {
    Logger.log(`Scoring failed: ${scoringError.message}`);
    
    // Save candidate with error state
    saveCandidateWithScoringError(
      candidateId, 
      metadata, 
      jobMatch, 
      attachmentResults, 
      emailHash,
      scoringError.message
    );
    
    logError('SCORING_FAILED', candidateId, scoringError.message, message.getId());
    return;
  }

  scoringResult.skills_extracted = normalizeSkills(scoringResult.skills_extracted);

  saveCandidateData(
    candidateId, 
    metadata, 
    jobMatch, 
    scoringResult, 
    attachmentResults.resumeUrl,
    attachmentResults.coverLetterUrl,
    emailHash
  );

  const processingTime = new Date().getTime() - startTime;
  logProcessing(candidateId, message.getId(), scoringResult.llm_used, processingTime, scoringResult.api_cost);
  
  if (scoringResult.overall_score >= CONFIG.HIGH_SCORE_THRESHOLD) {
    sendHighScoreNotification(candidateId, scoringResult, jobMatch);
  }
  
  Logger.log(`Successfully processed candidate: ${candidateId} (Score: ${scoringResult.overall_score})`);
}

//Process all attachments to find resumes and cover letters
function processAllAttachments(attachments, candidateId) {
  const result = {
    resumeText: null,
    resumeUrl: null,
    coverLetterText: null,
    coverLetterUrl: null,
    allFiles: []
  };

  Logger.log(`Processing ${attachments.length} attachments for candidate ${candidateId}`);

  for (const attachment of attachments) {
    const fileName = attachment.getName().toLowerCase();
    
    if (!isResumeFile(fileName)) {
      Logger.log(`Skipping non-document file: ${fileName}`);
      continue;
    }

    const isCoverLetter = CONFIG.COVER_LETTER_KEYWORDS.some(keyword => 
      fileName.includes(keyword.replace(/\s+/g, ''))
    );

    try {
      const fileUrl = saveFileToDrive(attachment, candidateId, isCoverLetter);
      const fileText = extractTextFromFile(attachment);

      if (!fileText || fileText.trim().length < 50) {
        Logger.log(`Insufficient text extracted from ${fileName}`);
        continue;
      }

      result.allFiles.push({
        name: fileName,
        url: fileUrl,
        type: isCoverLetter ? 'cover_letter' : 'resume'
      });

      if (isCoverLetter) {
        result.coverLetterText = fileText;
        result.coverLetterUrl = fileUrl;
        Logger.log(`Cover letter identified: ${fileName}`);
      } else {
        const isResume = fileName.includes('resume') || fileName.includes('cv');
        
        if (!result.resumeText || isResume) {
          result.resumeText = fileText;
          result.resumeUrl = fileUrl;
          Logger.log(`Resume identified: ${fileName}`);
        }
      }
    } catch (error) {
      Logger.log(`Error processing attachment ${fileName}: ${error.message}`);
      logError('ATTACHMENT_PROCESSING_ERROR', candidateId, `${fileName}: ${error.message}`);
    }
  }

  // If we have multiple files but no explicit resume, use the longest document
  if (!result.resumeText && result.allFiles.length > 0) {
    Logger.log('No explicit resume found, using longest document');
    const allTexts = result.allFiles.map(f => ({
      file: f,
      text: extractTextFromFile(
        DriveApp.getFileById(f.url.match(/[-\w]{25,}/)[0]).getBlob()
      )
    }));
    
    allTexts.sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0));
    
    if (allTexts[0]?.text) {
      result.resumeText = allTexts[0].text;
      result.resumeUrl = allTexts[0].file.url;
    }
  }

  return result;
}

// NEW: Save file to Drive with proper naming
function saveFileToDrive(attachment, candidateId, isCoverLetter = false) {
  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ACTIVE);
  const fileType = isCoverLetter ? 'COVER' : 'RESUME';
  const fileName = `${candidateId}_${fileType}_${attachment.getName()}`;
  const file = folder.createFile(attachment.copyBlob().setName(fileName));
  return file.getUrl();
}

// METADATA EXTRACTION
function extractEmailMetadata(message){
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const senderEmail = message.getFrom().match(/<(.+)>/)?.[1] || message.getFrom();
  const senderName = message.getFrom().split('<')[0].trim();
  const receiveDate = message.getDate();

  let source = 'Email';
  if (subject.toLowerCase().includes('linkedin')) source = 'LinkedIn';
  else if (subject.toLowerCase().includes('indeed')) source = 'Indeed';
  else if (body.toLowerCase().includes('via linkedin')) source = 'LinkedIn';

  return {
    subject, body, senderEmail, senderName, receiveDate, source, messageId: message.getId()
  };
}

// JD Matching
function matchJobDescription(subject, body){
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('JOB_DESCRIPTIONS');
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++){
    const row = data[i];
    const jobId = row[0];
    const roleTitle = row[1];
    const status = row[3];

    if (status === 'closed') continue;

    const searchText = (subject + ' ' + body).toLowerCase();
    const roleTitleLower = roleTitle.toLowerCase();

    if (searchText.includes(roleTitleLower)) {
      return{
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
  return null;
}

function parseScoringWeights(weightsJson) {
  try {
    return JSON.parse(weightsJson || '{}'); 
  } catch {
    return getDefaultScoringCriteria();
  }
}

function getDefaultScoringCriteria(){
  return{
    skills: 45, experience: 30, education: 15, additional: 10
  };
}

function getDefaultJD(){
  return "General technical position requiring strong problem-solving skills and relevant experience.";
}

// Detect duplication
function checkDuplicate(emailHash){
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES');
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === emailHash) { 
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
      const notesCol = 24; // Adjust based on actual column
      const currentNotes = data[i][notesCol] || '';
      const newNote = `Re-applied on ${metadata.receiveDate.toISOString().split('T')[0]}`;
      sheet.getRange(i + 1, notesCol + 1).setValue(currentNotes + '\n' + newNote);
      
      Logger.log(`Updated duplicate record: ${candidateId}`);
      break;
    }
  }
}

// PII Extraction and Anonymization with IMPROVED REGEX ESCAPING
function extractAndAnonymizePII(resumeText, metadata, coverLetterText = null) {
  const pii = {
    full_name: metadata.senderName || extractNameFromResume(resumeText),
    email: metadata.senderEmail,
    phone: extractPhone(resumeText),
    address: extractAddress(resumeText),
    linkedin_url: extractLinkedIn(resumeText)
  };

  let anonymizedResume = resumeText;
  let anonymizedCoverLetter = coverLetterText;

  // Helper function to safely replace with proper regex escaping
  function safeReplace(text, value, replacement) {
    if (!text || !value) return text;
    try {
      const escapedValue = escapeRegex(value);
      return text.replace(new RegExp(escapedValue, 'gi'), replacement);
    } catch (error) {
      Logger.log(`Regex error for value "${value}": ${error.message}`);
      return text.split(value).join(replacement);
    }
  }

  // Anonymize resume
  if (pii.full_name) {
    anonymizedResume = safeReplace(anonymizedResume, pii.full_name, 'CANDIDATE_NAME');
    if (anonymizedCoverLetter) {
      anonymizedCoverLetter = safeReplace(anonymizedCoverLetter, pii.full_name, 'CANDIDATE_NAME');
    }
  }
  
  if (pii.email) {
    anonymizedResume = safeReplace(anonymizedResume, pii.email, 'EMAIL_REDACTED');
    if (anonymizedCoverLetter) {
      anonymizedCoverLetter = safeReplace(anonymizedCoverLetter, pii.email, 'EMAIL_REDACTED');
    }
  }
  
  if (pii.phone) {
    anonymizedResume = safeReplace(anonymizedResume, pii.phone, 'PHONE_REDACTED');
    if (anonymizedCoverLetter) {
      anonymizedCoverLetter = safeReplace(anonymizedCoverLetter, pii.phone, 'PHONE_REDACTED');
    }
  }
  
  if (pii.address) {
    anonymizedResume = safeReplace(anonymizedResume, pii.address, 'LOCATION_REDACTED');
    if (anonymizedCoverLetter) {
      anonymizedCoverLetter = safeReplace(anonymizedCoverLetter, pii.address, 'LOCATION_REDACTED');
    }
  }
  
  return { 
    pii, 
    anonymizedResume,
    anonymizedCoverLetter
  };
}

function extractNameFromResume(text) {
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
  if (!str) return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isResumeFile(filename) {
  const validExtensions = ['.pdf', '.docx', '.doc', '.txt', '.rtf', '.odt'];
  return validExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

function saveResumeToDrive(attachment, candidateId) {
  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ACTIVE);
  const fileName = `${candidateId}_${attachment.getName()}`;
  const file = folder.createFile(attachment.copyBlob().setName(fileName));
  return file.getUrl();
}

// [FILE EXTRACTION FUNCTIONS REMAIN THE SAME - keeping them as is for brevity]
// Include all the extractTextFromFile, extractTextFromPDF, etc. functions from original

// Skills Normalization
function normalizeSkills(skills) {
  if (!skills || !Array.isArray(skills)) return [];
  
  const normalized = new Set();
  
  for (const skill of skills) {
    const lowerSkill = skill.toLowerCase().trim();
    let matched = false;
    
    for (const [canonical, variations] of Object.entries(CONFIG.SKILL_VARIATIONS)) {
      if (variations.includes(lowerSkill)) {
        normalized.add(canonical);
        matched = true;
        break;
      }
    }
    
    // If no match found, keep original (capitalized)
    if (!matched) {
      normalized.add(skill.trim());
    }
  }
  
  return Array.from(normalized);
}

// LLM Scoring
function scoreResumeWithLLMs(anonymizedResume, jdText, scoringCriteria, candidateId, coverLetterText = null) {
  let result = null;
  let attempts = [];
  
  // PRIMARY: Gemini
  try {
    result = callGeminiWithRetry(anonymizedResume, jdText, scoringCriteria, coverLetterText);
    attempts.push({ llm: 'gemini-2.0-flash', success: true, confidence: result.confidence_level });
    
  } catch (geminiError) {
    Logger.log(`Gemini failed: ${geminiError.message}`);
    attempts.push({ llm: 'gemini-2.0-flash', success: false, error: geminiError.message });
    
    // SECONDARY: GPT
    try {
      result = callGPTWithRetry(anonymizedResume, jdText, scoringCriteria, coverLetterText);
      attempts.push({ llm: 'gpt-4o-mini', success: true });
      
    } catch (gptError) {
      Logger.log(`GPT failed: ${gptError.message}`);
      attempts.push({ llm: 'gpt-4o-mini', success: false, error: gptError.message });
      
      // TERTIARY: Claude
      try {
        result = callClaudeWithRetry(anonymizedResume, jdText, scoringCriteria, coverLetterText);
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

// Wrapper functions with retry logic
function callGeminiWithRetry(resume, jd, criteria, coverLetter) {
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      return callGemini(resume, jd, criteria, coverLetter);
    } catch (error) {
      if (attempt === CONFIG.MAX_RETRIES) throw error;
      Logger.log(`Gemini attempt ${attempt} failed, retrying...`);
      Utilities.sleep(CONFIG.RETRY_DELAY_MS * attempt);
    }
  }
}

function callGPTWithRetry(resume, jd, criteria, coverLetter) {
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      return callGPT(resume, jd, criteria, coverLetter);
    } catch (error) {
      if (attempt === CONFIG.MAX_RETRIES) throw error;
      Logger.log(`GPT attempt ${attempt} failed, retrying...`);
      Utilities.sleep(CONFIG.RETRY_DELAY_MS * attempt);
    }
  }
}

function callClaudeWithRetry(resume, jd, criteria, coverLetter) {
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      return callClaude(resume, jd, criteria, coverLetter);
    } catch (error) {
      if (attempt === CONFIG.MAX_RETRIES) throw error;
      Logger.log(`Claude attempt ${attempt} failed, retrying...`);
      Utilities.sleep(CONFIG.RETRY_DELAY_MS * attempt);
    }
  }
}

function buildPrompt(anonymizedResume, jdText, scoringCriteria, coverLetterText = null) {
  let prompt = `You are an expert technical recruiter evaluating a candidate's resume.

JOB DESCRIPTION:
${jdText}

CANDIDATE RESUME (ANONYMIZED):
${anonymizedResume}`;

  if (coverLetterText) {
    prompt += `\n\nCOVER LETTER:
${coverLetterText}`;
  }

  prompt += `\n\nSCORING CRITERIA:
- Skills Match: ${scoringCriteria.skills || 45}% weight
- Experience: ${scoringCriteria.experience || 30}% weight
- Education: ${scoringCriteria.education || 15}% weight
- Additional Factors: ${scoringCriteria.additional || 10}% weight

IMPORTANT - BIAS PREVENTION:
- Candidate's personal identifiers have been redacted for fairness
- Evaluate ONLY based on skills, experience, and qualifications
- Do NOT consider: name, gender, ethnicity, age, university prestige
- Focus on: technical abilities, relevant experience, demonstrated achievements

CRITICAL: You MUST return a complete, valid JSON object. Do not truncate or omit any fields.

OUTPUT FORMAT (respond ONLY with valid JSON, no markdown backticks):
{
  "skills_extracted": ["skill1", "skill2", "skill3"],
  "experience_years": 5.5,
  "experience_details": [
    {"role": "Senior Developer", "company": "COMPANY_A", "duration_years": 3, "key_achievements": ["achievement1", "achievement2"]}
  ],
  "education": [
    {"degree": "BS Computer Science", "institution": "UNIVERSITY_A", "year": 2018}
  ],
  "certifications": ["AWS Certified", "None"],
  "skills_match_score": 85,
  "experience_match_score": 80,
  "education_score": 75,
  "additional_score": 70,
  "overall_score": 82,
  "reasoning": "Detailed explanation of scoring in 2-3 sentences",
  "red_flags": ["6-month employment gap in 2022", "None"],
  "confidence_level": 0.89
}

ENSURE ALL FIELDS ARE PRESENT. If a candidate has no certifications, use ["None"]. If no red flags, use ["None"].`;

  return prompt;
}

// Parse JSON with fallback handling
function parseJSONSafely(text, source = 'LLM') {
  try {
    // Remove markdown code blocks if present
    let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const parsed = JSON.parse(cleaned);
    
    // Validate required fields
    const required = [
      'skills_extracted', 'experience_years', 'experience_details',
      'education', 'certifications', 'skills_match_score',
      'experience_match_score', 'education_score', 'additional_score',
      'overall_score', 'reasoning', 'red_flags', 'confidence_level'
    ];
    
    const missing = required.filter(field => !(field in parsed));
    
    if (missing.length > 0) {
      Logger.log(`${source} returned incomplete JSON. Missing: ${missing.join(', ')}`);
      
      // Fill in missing fields with defaults
      if (!parsed.skills_extracted) parsed.skills_extracted = [];
      if (!parsed.experience_years) parsed.experience_years = 0;
      if (!parsed.experience_details) parsed.experience_details = [];
      if (!parsed.education) parsed.education = [];
      if (!parsed.certifications) parsed.certifications = ['None'];
      if (!parsed.skills_match_score) parsed.skills_match_score = 0;
      if (!parsed.experience_match_score) parsed.experience_match_score = 0;
      if (!parsed.education_score) parsed.education_score = 0;
      if (!parsed.additional_score) parsed.additional_score = 0;
      if (!parsed.overall_score) parsed.overall_score = 0;
      if (!parsed.reasoning) parsed.reasoning = 'Incomplete scoring data';
      if (!parsed.red_flags) parsed.red_flags = ['None'];
      if (!parsed.confidence_level) parsed.confidence_level = 0.5;
    }
    
    if (!Array.isArray(parsed.skills_extracted)) parsed.skills_extracted = [];
    if (!Array.isArray(parsed.experience_details)) parsed.experience_details = [];
    if (!Array.isArray(parsed.education)) parsed.education = [];
    if (!Array.isArray(parsed.certifications)) parsed.certifications = ['None'];
    if (!Array.isArray(parsed.red_flags)) parsed.red_flags = ['None'];
    
    return parsed;
    
  } catch (error) {
    Logger.log(`JSON parsing failed for ${source}: ${error.message}`);
    Logger.log(`Raw response: ${text.substring(0, 500)}`);
    throw new Error(`Invalid JSON from ${source}: ${error.message}`);
  }
}

function callGemini(resume, jd, criteria, coverLetter) {
  const prompt = buildPrompt(resume, jd, criteria, coverLetter);
  
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
        maxOutputTokens: 3000,
        responseMimeType: "application/json"
      }
    }),
    muteHttpExceptions: true
  });
  
  const data = JSON.parse(response.getContentText());
  if (data.error) throw new Error(data.error.message);
  
  const resultText = data.candidates[0].content.parts[0].text;
  const result = parseJSONSafely(resultText, 'Gemini');
  
  result.llm_used = 'gemini-2.0-flash';
  result.api_cost = estimateGeminiCost(prompt, resultText);
  
  return result;
}

function callGPT(resume, jd, criteria, coverLetter) {
  const prompt = buildPrompt(resume, jd, criteria, coverLetter);
  
  const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.OPENAI_API_KEY
    },
    payload: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an expert technical recruiter. Respond only with valid JSON. Include ALL required fields." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 3000
    }),
    muteHttpExceptions: true
  });
  
  const data = JSON.parse(response.getContentText());
  if (data.error) throw new Error(data.error.message);
  
  const resultText = data.choices[0].message.content;
  const result = parseJSONSafely(resultText, 'GPT');
  
  result.llm_used = 'gpt-4o-mini';
  result.api_cost = estimateGPTCost(prompt, resultText);
  
  return result;
}

function callClaude(resume, jd, criteria, coverLetter) {
  const prompt = buildPrompt(resume, jd, criteria, coverLetter);
  
  const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 3000,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }]
    }),
    muteHttpExceptions: true
  });
  
  const data = JSON.parse(response.getContentText());
  if (data.error) throw new Error(data.error.message);
  
  const resultText = data.content[0].text;
  const result = parseJSONSafely(resultText, 'Claude');
  
  result.llm_used = 'claude-sonnet-4';
  result.api_cost = estimateClaudeCost(prompt, resultText);
  
  return result;
}

// Cost estimation functions
function estimateGeminiCost(prompt, response) {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  return (inputTokens * 0.000001875) + (outputTokens * 0.0000075);
}

function estimateGPTCost(prompt, response) {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  return (inputTokens * 0.00015 / 1000) + (outputTokens * 0.0006 / 1000);
}

function estimateClaudeCost(prompt, response) {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  return (inputTokens * 0.003 / 1000) + (outputTokens * 0.015 / 1000);
}

// DATA STORAGE
function storePII(candidateId, pii) {
  try {
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
      new Date(Date.now() + CONFIG.DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    ]);
    
    Logger.log(`PII stored for candidate: ${candidateId}`);
  } catch (error) {
    Logger.log(`Error storing PII: ${error.message}`);
    throw error;
  }
}

function saveCandidateData(candidateId, metadata, jobMatch, scoringResult, resumeUrl, coverLetterUrl, emailHash) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES');
    
    const phoneHash = scoringResult.phone ? hashString(scoringResult.phone) : '';
    
    sheet.appendRow([
      candidateId,
      emailHash,
      phoneHash,
      jobMatch ? jobMatch.job_id : 'UNMATCHED',
      metadata.source,
      metadata.receiveDate,
      resumeUrl,
      coverLetterUrl || 'N/A',
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
    
    Logger.log(`Candidate data saved: ${candidateId}`);
  } catch (error) {
    Logger.log(`Error saving candidate data: ${error.message}`);
    throw error;
  }
}

// NEW: Save candidate without resume (partial data)
function saveCandidateWithoutResume(candidateId, metadata, emailHash) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES');
    
    sheet.appendRow([
      candidateId,
      emailHash,
      '', // phone_hash
      'UNMATCHED',
      metadata.source,
      metadata.receiveDate,
      'NO_RESUME_FOUND',
      'N/A',
      'N/A', // skills
      0, // experience_years
      '[]', // experience_details
      '[]', // education
      'N/A', // certifications
      0, // overall_score
      0, // skills_match_score
      0, // experience_match_score
      0, // education_score
      0, // additional_score
      'No resume found in attachments',
      'No resume available for scoring',
      'N/A', // llm_used
      0, // confidence_level
      'Error - No Resume',
      '', // hr_rating
      'Review email manually - no resume detected',
      'Not Contacted',
      new Date()
    ]);
    
    Logger.log(`Candidate saved without resume: ${candidateId}`);
  } catch (error) {
    Logger.log(`Error saving candidate without resume: ${error.message}`);
    logError('SAVE_ERROR', candidateId, error.message);
  }
}

// Save candidate with scoring error
function saveCandidateWithScoringError(candidateId, metadata, jobMatch, attachmentResults, emailHash, errorMessage) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('CANDIDATES');
    
    sheet.appendRow([
      candidateId,
      emailHash,
      '', // phone_hash
      jobMatch ? jobMatch.job_id : 'UNMATCHED',
      metadata.source,
      metadata.receiveDate,
      attachmentResults.resumeUrl || 'N/A',
      attachmentResults.coverLetterUrl || 'N/A',
      'N/A', // skills
      0, // experience_years
      '[]', // experience_details
      '[]', // education
      'N/A', // certifications
      0, // overall_score
      0, // skills_match_score
      0, // experience_match_score
      0, // education_score
      0, // additional_score
      'Scoring failed',
      `Error during scoring: ${errorMessage}`,
      'SCORING_FAILED', // llm_used
      0, // confidence_level
      'Error - Scoring Failed',
      '', // hr_rating
      'Manual review required - automated scoring failed',
      'Not Contacted',
      new Date()
    ]);
    
    Logger.log(`Candidate saved with scoring error: ${candidateId}`);
  } catch (error) {
    Logger.log(`Error saving candidate with scoring error: ${error.message}`);
    logError('SAVE_ERROR', candidateId, error.message);
  }
}

// LOGGING
function logProcessing(candidateId, emailId, llmUsed, processingTime, apiCost) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('PROCESSING_LOG');
    
    sheet.appendRow([
      `LOG_${new Date().getTime()}`,
      new Date(),
      emailId,
      candidateId,
      'Resume Processed',
      llmUsed,
      processingTime,
      Math.ceil(processingTime / 4),
      apiCost,
      'Success'
    ]);
  } catch (error) {
    Logger.log(`Error logging processing: ${error.message}`);
  }
}

function logError(errorType, candidateId, errorMessage, emailId = '') {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName('ERROR_LOG');
    
    sheet.appendRow([
      `ERR_${new Date().getTime()}`,
      new Date(),
      errorType,
      emailId,
      candidateId || '',
      errorMessage,
      '',
      0,
      'Pending',
      'FALSE'
    ]);
  } catch (error) {
    Logger.log(`Error logging error: ${error.message}`);
  }
}

// NOTIFICATIONS
function sendHighScoreNotification(candidateId, scoringResult, jobMatch) {
  const webhook = CONFIG.SLACK_WEBHOOK_URGENT;
  if (!webhook) return;
  
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}`;
  const jobTitle = jobMatch ? jobMatch.role_title : 'General Position';
  
  const message = {
    text: "High-Quality Candidate Detected!",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Excellent Candidate Match"
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
  
  try {
    UrlFetchApp.fetch(webhook, {
      method: "POST",
      contentType: "application/json",
      payload: JSON.stringify(message),
      muteHttpExceptions: true
    });
  } catch (error) {
    Logger.log(`Error sending Slack notification: ${error.message}`);
  }
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
  
  try {
    UrlFetchApp.fetch(webhook, {
      method: "POST",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (error) {
    Logger.log(`Error sending Slack alert: ${error.message}`);
  }
}

// DAILY DIGEST - Triggered at 8am daily
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
    text: "Daily Recruiting Summary",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Recruiting Summary - ${formatDate(yesterday)}`
        }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Total Resumes:*\n${stats.total}` },
          { type: "mrkdwn", text: `*High Quality (≥75):*\n${stats.high_quality}` },
          { type: "mrkdwn", text: `*Medium (65-74):*\n${stats.medium_quality}` },
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
  
  try {
    UrlFetchApp.fetch(webhook, {
      method: "POST",
      contentType: "application/json",
      payload: JSON.stringify(message),
      muteHttpExceptions: true
    });
  } catch (error) {
    Logger.log(`Error sending daily digest: ${error.message}`);
  }
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
    const submissionDate = new Date(data[i][5]);
    
    if (submissionDate >= startDate && submissionDate < endDate) {
      total++;
      const score = data[i][13];
      
      // Only add to total if it's a valid score
      if (score > 0) {
        totalScore += score;
        
        if (score >= 75) highQuality++;
        else if (score >= 65) mediumQuality++;
        else lowQuality++;
        
        topCandidates.push({
          id: data[i][0],
          score: score,
          role: data[i][3],
          skills: data[i][8]
        });
      }
    }
  }

  // Sort and get top 5
  topCandidates.sort((a, b) => b.score - a.score);
  topCandidates = topCandidates.slice(0, 5);
  
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

// DATA CLEANUP - deletes old resumes
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

// UTILITY FUNCTIONS
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

// CUSTOM MENU - Shows when sheet is opened
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Recruiting System')
    .addItem('Process New Resumes Now', 'processNewResumes')
    .addItem('Send Daily Digest', 'sendDailyDigest')
    .addItem('Cleanup Old Resumes', 'cleanupOldResumes')
    .addSeparator()
    .addItem('Setup Triggers', 'setupTriggers')
    .addItem('View API Keys', 'showApiKeysDialog')
    .addItem('Test File Extraction', 'testExtractionDialog')
    .addToUi();
}

// SETUP & CONFIGURATION
function setupTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  
  ScriptApp.newTrigger('processNewResumes')
    .timeBased()
    .everyMinutes(15)
    .create();
  
  ScriptApp.newTrigger('sendDailyDigest')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();
  
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

// INITIAL SETUP HELPER - Run this once after creating the sheet
function initializeSystem() {
  try {
    GmailApp.getUserLabelByName('recruiting') || GmailApp.createLabel('recruiting');
    GmailApp.getUserLabelByName('Processed') || GmailApp.createLabel('Processed');
  } catch (e) {
    Logger.log('Gmail labels already exist or error creating: ' + e);
  }
  
  setupTriggers();
  
  SpreadsheetApp.getUi().alert('System initialized!\n\nNext steps:\n1. Set API keys in Script Properties\n2. Configure Slack webhooks\n3. Update CONFIG with your Sheet ID and Drive Folder ID\n4. Test with a sample email');
}

// FILE EXTRACTION FUNCTIONS (Complete implementations)
function extractTextFromFile(attachment) {
  const contentType = attachment.getContentType();
  const fileName = attachment.getName().toLowerCase();
  
  Logger.log(`Extracting text from: ${attachment.getName()} (${contentType})`);
  
  try {
    if (contentType === 'application/pdf' || fileName.endsWith('.pdf')) {
      let text = extractTextFromPDF(attachment);
      
      if (!text || text.trim().length < 50) {
        Logger.log('Drive OCR produced insufficient text, trying Gemini fallback...');
        text = extractTextFromPDFWithGemini(attachment);
      }
      
      return cleanExtractedText(text);
    }
    
    if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
        fileName.endsWith('.docx')) {
      let text = extractTextFromDOCX(attachment);
      
      if (!text || text.trim().length < 50) {
        Logger.log('Drive conversion failed, trying manual DOCX parsing...');
        text = extractTextFromDOCXManual(attachment);
      }
      
      return cleanExtractedText(text);
    }
    
    if (contentType === 'application/msword' || fileName.endsWith('.doc')) {
      return cleanExtractedText(extractTextFromDOC(attachment));
    }
    
    if (contentType === 'text/plain' || fileName.endsWith('.txt')) {
      return cleanExtractedText(attachment.getDataAsString());
    }
    
    if (contentType === 'application/rtf' || 
        contentType === 'text/rtf' || 
        fileName.endsWith('.rtf')) {
      return cleanExtractedText(extractTextFromRTF(attachment));
    }
    
    if (contentType === 'application/vnd.oasis.opendocument.text' || 
        fileName.endsWith('.odt')) {
      return cleanExtractedText(extractTextFromODT(attachment));
    }
    
    Logger.log(`Unsupported file format: ${contentType} / ${fileName}`);
    logError('UNSUPPORTED_FILE_FORMAT', null, `Format: ${contentType}, File: ${fileName}`);
    return null;
    
  } catch (error) {
    Logger.log(`Error in extractTextFromFile: ${error.message}`);
    logError('FILE_EXTRACTION_ERROR', null, error.message);
    return null;
  }
}

function extractTextFromPDF(attachment) {
  let tempFile = null;
  let tempDoc = null;
  
  try {
    Logger.log('Attempting PDF extraction via Google Drive OCR...');
    
    const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ACTIVE);
    const blob = attachment.copyBlob();
    tempFile = folder.createFile(blob);
    
    const resource = {
      title: tempFile.getName() + '_temp',
      mimeType: MimeType.GOOGLE_DOCS
    };
    
    const convertedFile = Drive.Files.copy(resource, tempFile.getId(), {
      ocr: true,
      ocrLanguage: 'en'
    });
    
    const doc = DocumentApp.openById(convertedFile.id);
    const text = doc.getBody().getText();
    
    Logger.log(`PDF extraction successful: ${text.length} characters extracted`);
    
    tempDoc = DriveApp.getFileById(convertedFile.id);
    tempDoc.setTrashed(true);
    tempFile.setTrashed(true);
    
    return text;
    
  } catch (error) {
    Logger.log(`Google Drive OCR failed: ${error.message}`);
    
    try {
      if (tempDoc) tempDoc.setTrashed(true);
      if (tempFile) tempFile.setTrashed(true);
    } catch (cleanupError) {
      Logger.log(`Cleanup failed: ${cleanupError.message}`);
    }
    
    return null;
  }
}

function extractTextFromPDFWithGemini(attachment) {
  try {
    Logger.log('Using Gemini for PDF extraction...');
    
    const base64Data = Utilities.base64Encode(attachment.getBytes());
    
    const payload = {
      contents: [{
        parts: [
          {
            inlineData: {
              data: base64Data,
              mimeType: "application/pdf"
            }
          },
          {
            text: "Extract all text from this document exactly as it appears. Return ONLY the extracted text with no additional commentary."
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4000
      }
    };
    
    const response = UrlFetchApp.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        method: "POST",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );
    
    const data = JSON.parse(response.getContentText());
    
    if (data.error) {
      throw new Error(data.error.message);
    }
    
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('Gemini returned no candidates');
    }
    
    const text = data.candidates[0].content.parts[0].text;
    Logger.log(`Gemini extraction successful: ${text.length} characters`);
    
    return text;
    
  } catch (error) {
    Logger.log(`Gemini PDF extraction failed: ${error.message}`);
    return null;
  }
}

function extractTextFromDOCX(attachment) {
  let tempFile = null;
  let tempDoc = null;
  
  try {
    Logger.log('Attempting DOCX extraction via Google Drive...');
    
    const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ACTIVE);
    const blob = attachment.copyBlob();
    tempFile = folder.createFile(blob);
    
    const resource = {
      title: tempFile.getName() + '_temp',
      mimeType: MimeType.GOOGLE_DOCS
    };
    
    const convertedFile = Drive.Files.copy(resource, tempFile.getId());
    const doc = DocumentApp.openById(convertedFile.id);
    const text = doc.getBody().getText();
    
    Logger.log(`DOCX extraction successful: ${text.length} characters extracted`);
    
    tempDoc = DriveApp.getFileById(convertedFile.id);
    tempDoc.setTrashed(true);
    tempFile.setTrashed(true);
    
    return text;
    
  } catch (error) {
    Logger.log(`Google Drive DOCX conversion failed: ${error.message}`);
    
    try {
      if (tempDoc) tempDoc.setTrashed(true);
      if (tempFile) tempFile.setTrashed(true);
    } catch (cleanupError) {
      Logger.log(`Cleanup failed: ${cleanupError.message}`);
    }
    
    return null;
  }
}

function extractTextFromDOCXManual(attachment) {
  try {
    Logger.log('Attempting manual DOCX extraction...');
    
    const bytes = attachment.getBytes();
    const unzipped = Utilities.unzip(Utilities.newBlob(bytes));
    
    let docXml = null;
    for (let i = 0; i < unzipped.length; i++) {
      const fileName = unzipped[i].getName();
      if (fileName === 'word/document.xml') {
        docXml = unzipped[i].getDataAsString();
        break;
      }
    }
    
    if (!docXml) {
      throw new Error('document.xml not found in DOCX archive');
    }
    
    const textMatches = docXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
    
    if (!textMatches || textMatches.length === 0) {
      throw new Error('No text content found in document.xml');
    }
    
    const text = textMatches
      .map(match => {
        const innerText = match.replace(/<w:t[^>]*>|<\/w:t>/g, '');
        return decodeXmlEntities(innerText);
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    Logger.log(`Manual DOCX extraction successful: ${text.length} characters`);
    return text;
    
  } catch (error) {
    Logger.log(`Manual DOCX extraction failed: ${error.message}`);
    return null;
  }
}

function extractTextFromDOC(attachment) {
  let tempFile = null;
  let tempDoc = null;
  
  try {
    Logger.log('Attempting DOC extraction via Google Drive...');
    
    const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ACTIVE);
    const blob = attachment.copyBlob();
    tempFile = folder.createFile(blob);
    
    const resource = {
      title: tempFile.getName() + '_temp',
      mimeType: MimeType.GOOGLE_DOCS
    };
    
    const convertedFile = Drive.Files.copy(resource, tempFile.getId());
    const doc = DocumentApp.openById(convertedFile.id);
    const text = doc.getBody().getText();
    
    Logger.log(`DOC extraction successful: ${text.length} characters extracted`);
    
    tempDoc = DriveApp.getFileById(convertedFile.id);
    tempDoc.setTrashed(true);
    tempFile.setTrashed(true);
    
    return text;
    
  } catch (error) {
    Logger.log(`DOC extraction failed: ${error.message}`);
    
    try {
      if (tempDoc) tempDoc.setTrashed(true);
      if (tempFile) tempFile.setTrashed(true);
    } catch (cleanupError) {
      Logger.log(`Cleanup failed: ${cleanupError.message}`);
    }
    
    return null;
  }
}

function extractTextFromRTF(attachment) {
  try {
    Logger.log('Extracting text from RTF...');
    
    let text = attachment.getDataAsString();
    
    text = text
      .replace(/\\[a-z]+\d*\s?/g, '') 
      .replace(/[{}]/g, '')  
      .replace(/\\/g, '') 
      .replace(/\s+/g, ' ') 
      .trim();
    
    Logger.log(`RTF extraction successful: ${text.length} characters`);
    return text;
    
  } catch (error) {
    Logger.log(`RTF extraction failed: ${error.message}`);
    return null;
  }
}

function extractTextFromODT(attachment) {
  try {
    Logger.log('Attempting ODT extraction...');
    
    const bytes = attachment.getBytes();
    const unzipped = Utilities.unzip(Utilities.newBlob(bytes));
    
    let contentXml = null;
    for (let i = 0; i < unzipped.length; i++) {
      if (unzipped[i].getName() === 'content.xml') {
        contentXml = unzipped[i].getDataAsString();
        break;
      }
    }
    
    if (!contentXml) {
      throw new Error('content.xml not found in ODT archive');
    }
    
    const textMatches = contentXml.match(/<text:[^>]*>([^<]*)<\/text:[^>]*>/g);
    
    if (!textMatches || textMatches.length === 0) {
      throw new Error('No text content found in content.xml');
    }
    
    const text = textMatches
      .map(match => {
        const innerText = match.replace(/<text:[^>]*>|<\/text:[^>]*>/g, '');
        return decodeXmlEntities(innerText);
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    Logger.log(`ODT extraction successful: ${text.length} characters`);
    return text;
    
  } catch (error) {
    Logger.log(`ODT extraction failed: ${error.message}`);
    return null;
  }
}

// UTILITY FUNCTIONS
function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function cleanExtractedText(text) {
  if (!text) return '';
  
  return text
    .replace(/\s+/g, ' ')
    .replace(/\0/g, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// TESTING FUNCTIONS
function testExtractionDialog() {
  const html = `
    <p>Enter a Google Drive file ID to test extraction:</p>
    <input type="text" id="fileId" style="width: 100%; padding: 5px;" placeholder="File ID from Drive URL">
    <br><br>
    <button onclick="google.script.run.withSuccessHandler(showResult).testExtraction(document.getElementById('fileId').value)">Test Extraction</button>
    <div id="result" style="margin-top: 20px;"></div>
    
    <script>
      function showResult(result) {
        document.getElementById('result').innerHTML = '<pre>' + result + '</pre>';
      }
    </script>
  `;
  
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(500).setHeight(300),
    'Test File Extraction'
  );
}

function testExtraction(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    
    Logger.log(`Testing extraction for: ${file.getName()}`);
    Logger.log(`File type: ${blob.getContentType()}`);
    Logger.log(`File size: ${blob.getBytes().length} bytes`);
    
    const text = extractTextFromFile(blob);
    
    if (text) {
      const preview = text.substring(0, 500);
      Logger.log(`Extraction successful!`);
      Logger.log(`Extracted ${text.length} characters`);
      Logger.log(`Word count: ${text.split(/\s+/).length}`);
      
      return `SUCCESS!\n\nFile: ${file.getName()}\nExtracted: ${text.length} characters\nWords: ${text.split(/\s+/).length}\n\nPreview:\n${preview}...`;
    } else {
      Logger.log(`Extraction failed`);
      return `FAILED: Could not extract text from ${file.getName()}`;
    }
    
  } catch (error) {
    Logger.log(`Test failed: ${error.message}`);
    return `ERROR: ${error.message}`;
  }
}

// NEW: Batch processing function for testing
function testBatchProcessing() {
  Logger.log('Starting batch processing test...');
  
  const testEmails = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 5);
  
  for (let i = 0; i < testEmails.length; i++) {
    Logger.log(`\n=== Processing test email ${i + 1}/${testEmails.length} ===`);
    
    const messages = testEmails[i].getMessages();
    for (const message of messages) {
      if (message.isUnread() && message.getAttachments().length > 0) {
        try {
          processEmail(message);
          Logger.log(`✓ Successfully processed email from ${message.getFrom()}`);
        } catch (error) {
          Logger.log(`✗ Failed to process email: ${error.message}`);
        }
      }
    }
  }
  
  Logger.log('\n=== Batch processing test complete ===');
}

// NEW: Validation function to check system health
function validateSystemHealth() {
  const results = {
    apiKeys: {},
    sheets: {},
    folders: {},
    triggers: {},
    overall: true
  };
  
  // Check API keys
  results.apiKeys.gemini = !!CONFIG.GEMINI_API_KEY;
  results.apiKeys.openai = !!CONFIG.OPENAI_API_KEY;
  results.apiKeys.anthropic = !!CONFIG.ANTHROPIC_API_KEY;
  
  if (!results.apiKeys.gemini && !results.apiKeys.openai && !results.apiKeys.anthropic) {
    results.overall = false;
    Logger.log('No API keys configured');
  }
  
  // Check sheets
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    results.sheets.candidates = !!ss.getSheetByName('CANDIDATES');
    results.sheets.pii = !!ss.getSheetByName('CANDIDATES_PII');
    results.sheets.jd = !!ss.getSheetByName('JOB_DESCRIPTIONS');
    results.sheets.processing = !!ss.getSheetByName('PROCESSING_LOG');
    results.sheets.errors = !!ss.getSheetByName('ERROR_LOG');
    
    if (!results.sheets.candidates || !results.sheets.pii) {
      results.overall = false;
      Logger.log('Required sheets missing');
    }
  } catch (error) {
    results.overall = false;
    Logger.log(`Cannot access spreadsheet: ${error.message}`);
  }
  
  // Check Drive folder
  try {
    DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ACTIVE);
    results.folders.active = true;
  } catch (error) {
    results.overall = false;
    results.folders.active = false;
    Logger.log(`Cannot access Drive folder: ${error.message}`);
  }
  
  // Check triggers
  const triggers = ScriptApp.getProjectTriggers();
  results.triggers.count = triggers.length;
  results.triggers.processResumes = triggers.some(t => t.getHandlerFunction() === 'processNewResumes');
  results.triggers.dailyDigest = triggers.some(t => t.getHandlerFunction() === 'sendDailyDigest');
  results.triggers.cleanup = triggers.some(t => t.getHandlerFunction() === 'cleanupOldResumes');
  
  if (triggers.length === 0) {
    Logger.log('No triggers configured. Run setupTriggers()');
  }
  
  // Output results
  Logger.log('\n=== SYSTEM HEALTH CHECK ===');
  Logger.log(`Overall Status: ${results.overall ? 'HEALTHY' : 'ISSUES FOUND'}`);
  Logger.log('\nAPI Keys:');
  Logger.log(`  Gemini: ${results.apiKeys.gemini ? '✓' : '✗'}`);
  Logger.log(`  OpenAI: ${results.apiKeys.openai ? '✓' : '✗'}`);
  Logger.log(`  Anthropic: ${results.apiKeys.anthropic ? '✓' : '✗'}`);
  Logger.log('\nSheets:');
  Logger.log(`  CANDIDATES: ${results.sheets.candidates ? '✓' : '✗'}`);
  Logger.log(`  CANDIDATES_PII: ${results.sheets.pii ? '✓' : '✗'}`);
  Logger.log(`  JOB_DESCRIPTIONS: ${results.sheets.jd ? '✓' : '✗'}`);
  Logger.log(`  PROCESSING_LOG: ${results.sheets.processing ? '✓' : '✗'}`);
  Logger.log(`  ERROR_LOG: ${results.sheets.errors ? '✓' : '✗'}`);
  Logger.log('\nDrive:');
  Logger.log(`  Active Folder: ${results.folders.active ? '✓' : '✗'}`);
  Logger.log('\nTriggers:');
  Logger.log(`  Total: ${results.triggers.count}`);
  Logger.log(`  Process Resumes: ${results.triggers.processResumes ? '✓' : '✗'}`);
  Logger.log(`  Daily Digest: ${results.triggers.dailyDigest ? '✓' : '✗'}`);
  Logger.log(`  Cleanup: ${results.triggers.cleanup ? '✓' : '✗'}`);
  
  return results;
}