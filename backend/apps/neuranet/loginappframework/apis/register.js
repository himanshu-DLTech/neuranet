/**
 * Registers a new user. 
 * (C) 2020 TekMonks. All rights reserved.
 */
const mustache = require('mustache');
const utils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const crypt = require(`${CONSTANTS.LIBDIR}/crypt.js`);
const totp = require(`${APP_CONSTANTS.LIB_DIR}/totp.js`);
const mailer = require(`${APP_CONSTANTS.LIB_DIR}/mailer.js`);
const userid = require(`${APP_CONSTANTS.LIB_DIR}/userid.js`);
const queueExecutor = require(`${CONSTANTS.LIBDIR}/queueExecutor.js`);
const emailTemplate = require(`${APP_CONSTANTS.CONF_DIR}/email.json`);

const DEFAULT_QUEUE_DELAY = 500, NEW_USER_LISTENERS_MEMORY_KEY = "__org_monkshu_loginapp_registeration_listeners", 
	REASONS = {ID_EXISTS: "exists", OTP_ERROR: "otp", INTERNAL_ERROR: "internal", 
		SECURITY_ERROR: "securityerror", DOMAIN_ERROR: "domainerror", ID_DOESNT_EXIST: "iddoesntexist"};

exports.doService = async (jsonReq, servObject) => {
	if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
	else return exports.addUser(jsonReq, servObject);
}

exports.addUser = async (jsonReq, servObject, byAdmin=false) => {	
	LOG.debug("Got register request for ID: " + jsonReq.id);

	if (!(await exports.shouldAllowDomain(jsonReq, "id"))) {	// domain is not allowed
		LOG.error(`Unable to register: ${jsonReq.name}, ID: ${jsonReq.id}, domain is not allowed.`);
		return {...CONSTANTS.FALSE_RESULT, reason: REASONS.DOMAIN_ERROR};
	}

	if ((!byAdmin) && (!totp.verifyTOTP(jsonReq.totpSecret, jsonReq.totpCode))) {	// verify TOTP for non admin registrations
		LOG.error(`Unable to register: ${jsonReq.name}, ID: ${jsonReq.id}, wrong totp code`);
		return {...CONSTANTS.FALSE_RESULT, reason: REASONS.OTP_ERROR};
	}
    jsonReq.org = jsonReq.org.toLowerCase();
	await exports.updateOrgAndDomain(jsonReq);

	if (!await exports.checkOrgAndDomainMatch(jsonReq)) {	// security check for org and domain match
		LOG.error(`Unable to register: ${jsonReq.name}, ID: ${jsonReq.id}, security error, org and domain mismatch.`);
		return {...CONSTANTS.FALSE_RESULT, reason: REASONS.SECURITY_ERROR};
	}

	const rootOrg = await userid.getRootOrgForDomain(exports.getRootDomain(jsonReq)),	// rootOrg is null if domain is whitelisted but first registration for the org
		existingUsersForThisUsersRootOrg = rootOrg?await userid.getUsersForRootOrg(rootOrg):false,
		approved = byAdmin ? jsonReq.approved : (APP_CONSTANTS.CONF.new_users_need_approval_from_admin?
			(existingUsersForThisUsersRootOrg?0:1) : 1),
		role = byAdmin ? jsonReq.role : (existingUsersForThisUsersRootOrg?"user":"admin"), 
		verifyEmail = byAdmin ? jsonReq.verifyEmail : (APP_CONSTANTS.CONF.verify_email_on_registeration ? 1 : 0);

	const result = await userid.register(jsonReq.id, jsonReq.name, jsonReq.org, jsonReq.pwph, jsonReq.totpSecret, role, 
		approved, verifyEmail, jsonReq.domain);
	if ((!result) || ((!result.result) && result.reason != userid.ID_EXISTS)) LOG.error(`Unable to register: ${jsonReq.name}, ID: ${jsonReq.id} DB error.`);
	else if (!result.result) LOG.error(`Unable to register: ${jsonReq.name}, ID: ${jsonReq.id} exists already.`);

	result.tokenflag = result.result && result.approved == 1 ? true:false;
	if (result.result) if (!_informNewUserListners(result)) {	// inform listeners and watch for a veto
		LOG.error(`Listener veto for id ${id}, for org ${org}. Dropping the ID.`);
		try {userid.deleteUser(id)} catch(_) {};	// try to drop the account
		return {...CONSTANTS.FALSE_RESULT, reason: REASONS.INTERNAL_ERROR};
	}

	if (result.result && verifyEmail) {	// send verification email
		let mailVerificationResult = false; try{mailVerificationResult = await _emailAccountVerification(result.id, result.name, result.org, jsonReq.lang);} catch (err) {}
		if (!mailVerificationResult) {
			LOG.info(`Unable to register: ${jsonReq.name}, ID: ${jsonReq.id} verification email error.`); 
			try {userid.deleteUser(id)} catch(_) {};	// try to drop the account
			return {...CONSTANTS.FALSE_RESULT, reason: REASONS.INTERNAL_ERROR};
		}
	}

	if (result.result) {
		LOG.info(`User registered: ${jsonReq.name}, ID: ${jsonReq.id}, approval status is: ${result.approved==1?true:false}`); 
		if (result.approved && (!byAdmin)) queueExecutor.add(userid.updateLoginStats, [jsonReq.id, Date.now(), 
			utils.getClientIP(servObject.req)], true, APP_CONSTANTS.CONF.login_update_delay||DEFAULT_QUEUE_DELAY);
		if (!result.approved) queueExecutor.add(_emailAdminNewRegistration, [result.id, result.name, result.org, jsonReq.lang], 
			true, DEFAULT_QUEUE_DELAY);
	}
	
	return {...result, needs_verification: verifyEmail, 
		reason:result.result?undefined:(result.reason==userid.ID_EXISTS?REASONS.ID_EXISTS:REASONS.INTERNAL_ERROR),
		approved: result.approved==1?true:false};
}

exports.updateOrgAndDomain = async jsonReq => {
	const rootDomain = exports.getRootDomain(jsonReq), rootOrg = await userid.getRootOrgForDomain(rootDomain);
	
	LOG.info(`Set domain for ${jsonReq.id} to ${rootDomain}.`); 
	jsonReq.domain = rootDomain;
	
	if (!rootOrg) return;	// can't update to any other org, since domain is allowed this is probably first registration
	
	const suborgsForOrg = _arrayToLowercase(await userid.getSubOrgs(rootOrg));
	if (!suborgsForOrg.includes(jsonReq.org.toLowerCase())) {	// if the incoming org is not recognized set it to root org
		LOG.info(`Adjusted org for ${jsonReq.id} from ${jsonReq.org} to ${rootOrg}.`); 
		jsonReq.org = rootOrg;
	}
}

exports.getRootDomain = function(jsonReq, idProperty="id") {
	const domain = jsonReq[idProperty].indexOf("@") != -1 ? 
		jsonReq[idProperty].substring(jsonReq[idProperty].indexOf("@")+1).toLowerCase() : "undefined"
	return domain;
}

exports.shouldAllowDomain = async function(jsonReq, idProperty) {
	const domain = exports.getRootDomain(jsonReq, idProperty);
	return await userid.shouldAllowDomain(domain);
}

exports.checkOrgAndDomainMatch = async function (jsonReq, idProperty, mustHaveDomains) {
	const rootDomain = exports.getRootDomain(jsonReq, idProperty).toLowerCase(), 
		rootOrg = await userid.getRootOrg(jsonReq.org), 
		domainsForOrg = _arrayToLowercase(await userid.getDomainsForOrg(rootOrg||jsonReq.org));
	// if this organization currently has no domains registered then return true unless caller insists we must have domains
	if ((!domainsForOrg) || (!domainsForOrg.length)) if (mustHaveDomains) return false; else return true;

	if (domainsForOrg.includes(rootDomain)) return true;	// matches
}

exports.addNewUserListener = (modulePath, functionName) => {
	const newuserListeners = CLUSTER_MEMORY.get(NEW_USER_LISTENERS_MEMORY_KEY, []);
	newuserListeners.push({modulePath, functionName});
	CLUSTER_MEMORY.set(NEW_USER_LISTENERS_MEMORY_KEY, newuserListeners);
}

exports.REASONS = REASONS;

async function _emailAccountVerification(id, name, org, lang) {
	const cryptID = crypt.encrypt(id), cryptTime = crypt.encrypt(utils.getUnixEpoch().toString()), 
        action_url = APP_CONSTANTS.CONF.base_url + Buffer.from(`${APP_CONSTANTS.CONF.verify_url}?e=${cryptID}&t=${cryptTime}`).toString("base64"),
        button_code_pre = mustache.render(emailTemplate.button_code_pre, {action_url}), 
			button_code_post = mustache.render(emailTemplate.button_code_post, {action_url}),
        email_title = mustache.render(emailTemplate[`${lang||"en"}_verifyemail_title`], {name, org, action_url}),
        email_html = mustache.render(emailTemplate[`${lang||"en"}_verifyemail_html`], {name, org, button_code_pre,
			button_code_post}),
        email_text = mustache.render(emailTemplate[`${lang||"en"}_verifyemail_text`], {name, org, action_url});

	return await mailer.email(id, email_title, email_html, email_text);
}

async function _emailAdminNewRegistration(id, name, org, lang) {
	const admins = await userid.getAdminsFor(id); if (!admins) {LOG.error(`No admins found for user ${id}, skipping notifying new registration for the org.`); return;}
	for (const admin of admins) {	// email all admins that a new user has registered and needs approval
		const email = admin.id, adminname = admin.name, 
		action_url = APP_CONSTANTS.CONF.base_url + Buffer.from(APP_CONSTANTS.CONF.login_url).toString("base64"),
		button_code_pre = mustache.render(emailTemplate.button_code_pre, {action_url}), 
		button_code_post = mustache.render(emailTemplate.button_code_post, {action_url}),
		email_title = mustache.render(emailTemplate[`${lang||"en"}_newregistrationemail_title`], {adminname, org, name, id, action_url}),
		email_html = mustache.render(emailTemplate[`${lang||"en"}_newregistrationemail_html`], {adminname, org, name, id, button_code_pre,
			button_code_post}),
		email_text = mustache.render(emailTemplate[`${lang||"en"}_newregistrationemail_text`], {adminname, org, name, id, action_url});
		if (!(await mailer.email(email, email_title, email_html, email_text))) LOG.error(`Unable to notify the admin at ${email} for the new user registration of ID ${id}.`);
	}
}

const _arrayToLowercase = array => {
	if (!array) return array;
	const retArray = []; for (const element of array) retArray.push(element.toLowerCase()); return retArray;
}


const _informNewUserListners = async result => {
	const newuserListeners = CLUSTER_MEMORY.get(NEW_USER_LISTENERS_MEMORY_KEY, []);
	for (const listener of newuserListeners) {
		const listenerFunction = require(listener.modulePath)[listener.functionName];
		if (!(await listenerFunction(result))) return false; return true; 
	}
}

const validateRequest = jsonReq => (jsonReq && jsonReq.pwph && jsonReq.id && jsonReq.name && jsonReq.org && 
	jsonReq.totpSecret && jsonReq.totpCode && jsonReq.lang);