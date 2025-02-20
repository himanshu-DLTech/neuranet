/**
 * This strategy is to first find matching documents using TF.IDF and 
 * then use only their vectors for another TF search to build the final 
 * answer. This strategy works good for non-English languages, specially
 * Japanese and Chinese.
 * 
 * @returns search returns array of {metadata, text} objects matching the 
 * 			resulting documents. The texts are shards of the document of
 * 			context length specified in the embedding generation model which
 * 			was used to ingest the documents.
 * 
 * (C) 2023 TekMonks. All rights reserved.
 */

const NEURANET_CONSTANTS = LOGINAPP_CONSTANTS.ENV.NEURANETAPP_CONSTANTS;
const aidbfs = require(`${NEURANET_CONSTANTS.LIBDIR}/aidbfs.js`);
const aitfidfdb = require(`${NEURANET_CONSTANTS.LIBDIR}/aitfidfdb.js`);
const llmflowrunner = require(`${NEURANET_CONSTANTS.LIBDIR}/llmflowrunner.js`);

const REASONS = llmflowrunner.REASONS, TEMP_MEM_TFIDF_ID = "_com_tekmonks_neuranet_tempmem_tfidfdb_id_";

/**
 * Searches the AI DBs for the given query. Strategy is documents are searched
 * first using keyword search, then for the top matching documents, vector shards
 * are returned for the relevant portions of the document which can answer the
 * query.
 * 
 * @param params Contains the following properties
 * 							id The ID of the logged in user 
 * 							org The org of the logged in user's org
 * 							query The query to search for
 * 							brainid The AI application ID for the DB to search
 *                          topK_tfidf TopK for TD-IDF search
 *                          cutoff_score_tfidf Cutoff score for TF-IDF
 *                          topK_vectors TopK for vector search
 * 							autocorrect_query Default is true, set to false to turn off
 * 							punish_verysmall_documents If true smaller documents rank lower
 * 							bm25 If true BM25 adjustment is made to the rankings
 * @param {Object} _llmstepDefinition Not used, optional.
 * 
 * @returns The search returns array of {metadata, text} objects matching the 
 * 			resulting documents. The texts are shards of the document of
 * 			context length specified in the embedding generation model which
 * 			was used to ingest the documents.
 */
exports.search = async function(params, _llmstepDefinition) {
	const id = params.id, org = params.org, query = params.query, aiModelObjectForSearch = {...params},
		brainids = params.bridges ? (Array.isArray(params.bridges)?params.bridges:[params.bridges]) : [params.aiappid];
	if (!aiModelObjectForSearch.autocorrect_query) aiModelObjectForSearch.autocorrect_query = true;
	const autoCorrectQuery = params.autocorrect_query !== undefined ? params.autocorrect_query : aiModelObjectForSearch.autocorrect_query;
	const topK_tfidf = params.topK_tfidf || aiModelObjectForSearch.topK_tfidf;
	const cutoff_score_tfidf = params.cutoff_score_tfidf || aiModelObjectForSearch.cutoff_score_tfidf;
	const tfidfSearchOptions = {punish_verysmall_documents: params.punish_verysmall_documents||false, 
		ignore_coord: params.ignore_coord, max_coord_boost: params.max_coord_boost, bm25: params.bm25||false};

    const tfidfDBs = []; for (const brainidThis of brainids) tfidfDBs.push(...await aidbfs.getTFIDFDBsForIDAndOrgAndBrainID(id, org, brainidThis));
	if (!tfidfDBs.length) {	// no TF.IDF DB worked or found
		const errMsg = `Can't instantiate any TF.IDF DBs user ID ${id}. Giving up.`;
		params.return_error(errMsg, REASONS.INTERNAL); return;
	}
	let tfidfScoredDocuments = []; 
	for (const tfidfDB of tfidfDBs) { 
		const searchResults = await tfidfDB.query(query, topK_tfidf, params.metadata_filter_function, cutoff_score_tfidf, 
			tfidfSearchOptions, undefined, autoCorrectQuery);
		if (searchResults && searchResults.length) tfidfScoredDocuments.push(...searchResults);
		else LOG.warn(`No TF.IDF search documents found for query ${query} for id ${id} org ${org} and brainid ${brainids}.`);
	}
	if (tfidfScoredDocuments.length == 0) return _formatResults(params, []);	// no knowledge

	// now we need to rerank these documents according to their TF score only (IDF is not material for this collection)
	tfidfDBs[0].sortForTF(tfidfScoredDocuments); tfidfScoredDocuments = tfidfScoredDocuments.slice(0, 
		(topK_tfidf < tfidfScoredDocuments.length ? topK_tfidf : tfidfScoredDocuments.length))

	const documentsToUseDocIDs = []; for (const tfidfScoredDoc of tfidfScoredDocuments) 
		documentsToUseDocIDs.push(tfidfScoredDoc.metadata[NEURANET_CONSTANTS.NEURANET_DOCID]);
	
	let vectordbs = []; for (const brainidThis of brainids) {
		try {
			vectordbs.push(...await aidbfs.getVectorDBsForIDAndOrgAndBrainID(id, org, brainidThis, undefined, 
				NEURANET_CONSTANTS.CONF.multithreaded)) 
		} catch (err) { 
			const errMsg = `Can't instantiate the vector DB for brain ID ${brainidThis} user ID ${id} due to ${err}. Skipping this DB.`;
			LOG.error(errMsg); continue;
		}
	} 
	if (!vectordbs.length) {	// no vector DB worked or found
		const errMsg = `Can't instantiate any vector DBs user ID ${id} due to ${err}. Giving up.`;
		params.return_error(errMsg, REASONS.INTERNAL); return;
	}
	let vectorResults = [];
	for (const vectordb of vectordbs) vectorResults.push(...await vectordb.query(	// just get all the vectors for these documents
		undefined, undefined, undefined, 
		`return [${documentsToUseDocIDs.map(value=>`'${value}'`).join(",")}].includes(metadata['${NEURANET_CONSTANTS.NEURANET_DOCID}'])`));
	if ((!vectorResults) || (!vectorResults.length)) return _formatResults(params, []);	// no knowledge

	// create an in-memory temporary TF.IDF DB to search for relevant document fragments
	const tfidfDBInMem = await aitfidfdb.get_tfidf_db(TEMP_MEM_TFIDF_ID+Date.now(), NEURANET_CONSTANTS.NEURANET_DOCID, 
		NEURANET_CONSTANTS.NEURANET_LANGID, `${NEURANET_CONSTANTS.CONFDIR}/stopwords-iso.json`, undefined, true);
	for (const vectorResult of vectorResults) {
		const uniqueID = (Date.now() + Math.random()).toString().split(".").join(""); vectorResult.metadata.__uniqueid = uniqueID;
		const temporaryMetadata = {...(vectorResult.metadata)}; temporaryMetadata[NEURANET_CONSTANTS.NEURANET_DOCID]  = uniqueID;
		await tfidfDBInMem.create(vectorResult.text, temporaryMetadata); } 
	const topK_vectors = params.topK_vectors || aiModelObjectForSearch.topK_vectors;
	const tfidfVectors = await tfidfDBInMem.query(query, topK_tfidf, null, cutoff_score_tfidf), 
		searchResultsAll = tfidfDBInMem.sortForTF(tfidfVectors), 
		tfidfSearchResultsTopK = searchResultsAll.slice(0, topK_vectors);
	tfidfDBInMem.free_memory();

	const searchResultsTopK = []; for (const tfidfSearchResultTopKThis of tfidfSearchResultsTopK) 
		searchResultsTopK.push(...(vectorResults.filter(vectorResult => vectorResult.metadata.__uniqueid == tfidfSearchResultTopKThis.metadata.__uniqueid)));
    
    return _formatResults(params, searchResultsTopK);
}

function _formatResults(params, searchResultsTopK) {
	const searchResults = []; for (const searchResultTopKThis of searchResultsTopK) 
		if (!params.request.llm_format) searchResults.push({text: searchResultTopKThis.text, metadata: searchResultTopKThis.metadata});
		else searchResults.push(searchResultTopKThis.text);
    return params.request.llm_format?searchResults.join("\n\n"):searchResults;
}