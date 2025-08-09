const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const parseResultsStandard = require('./parseResultsStandard.js');
const parseResultsMultiDay = require('./parseResultsMultiDay.js');
const parseResultsRelay = require('./parseResultsRelay.js');
const { insertLogData } = require('./logHelpersGetResults.js');

// DEBUG: Bekräfta att rätt nyckel används
console.log('[DEBUG] SUPABASE_SERVICE_ROLE_KEY börjar med:', process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 8));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchResultsForEvent({ organisationId, eventId, batchid, apikey }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;

  try {
    // Kontrollera om det finns tidigare rader för denna klubb+event
    const { data: existingRows, error: selectError } = await supabase
      .from('results')
      .select('eventid')
      .eq('clubparticipation', organisationId)
      .eq('eventid', eventId);

    if (selectError) {
      console.error(`${logContext} Fel vid läsning av tidigare rader:`, selectError.message);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        errormessage: `Fel vid läsning av tidigare rader: ${selectError.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      return;
    }

    const numberOfRowsBefore = existingRows.length;
    if (numberOfRowsBefore > 0) {
      console.log(`${logContext} ${numberOfRowsBefore} rader tas bort innan nyimport.`);
      const { error: deleteError } = await supabase
        .from('results')
        .delete()
        .eq('clubparticipation', organisationId)
        .eq('eventid', eventId);
      if (deleteError) {
        console.error(`${logContext} Fel vid delete av tidigare rader:`, deleteError.message);
        await insertLogData(supabase, {
          source: 'GetResultsFetcher',
          level: 'error',
          errormessage: `Fel vid delete av tidigare rader: ${deleteError.message}`,
          organisationid: organisationId,
          eventid: eventId,
          batchid
        });
        return;
      }
    }

    // Eventor-anrop
    const baseUrl = `${process.env.SELF_BASE_URL}/api/eventor/results`;
    console.log('[Proxy] API-nyckel mottagen:', apikey);
    console.log('[Proxy] Anropar Eventor med URL:', 'https://eventor.orientering.se/api/results/organisation');
    console.log('[Proxy] Parametrar:', {
      organisationIds: String(organisationId),
      eventId: String(eventId),
      includeTrackCompetitors: false,
      includeSplitTimes: false,
      includeTimes: true,
      includeAdditionalResultValues: false
    });

    const response = await fetch(`${baseUrl}?eventId=${eventId}&organisationId=${organisationId}`, {
      headers: {
        'x-api-key': apikey
      }
    });

    const xml = await response.text();
      if (!response.ok) {
        console.error(`[GetResults] Eventor-svar för eventId=${eventId} är INTE OK (status ${response.status})`);
        console.error('[GetResults] Innehåll i svaret:', xml.slice(0, 500));
    }

    // Försök läsa eventForm direkt ur XML först (t.ex. <Event eventForm="IndMultiDay">)
    let eventformFromXml = null;
    const mEventForm = xml.match(/<Event[^>]*\beventForm="([^"]+)"/i);
    if (mEventForm) {
      eventformFromXml = mEventForm[1];
    }

    let parsed;
    // Collect warnings from the parser.  All parsers now return an object
    // with { results, warnings }.  Vi initialiserar warningsFromParse som
    // en tom array och tilldelar den baserat på parserns utdata nedan.
    let warningsFromParse = [];
    try {
      // Hämta eventform: prioritera XML-attributet, annars hämta första icke-nulla raden i events
      let eventform = eventformFromXml || '';
      if (!eventform) {
        const eventformRes = await supabase
          .from('events')
          .select('eventform')
          .eq('eventid', eventId)
          .not('eventform', 'is', null)
          .limit(1);
        if (eventformRes?.data && eventformRes.data.length > 0) {
          eventform = eventformRes.data[0].eventform || '';
        }
      }
      console.log(`${logContext} Eventform är: ${eventform}`);

      if (eventform === 'IndMultiDay') {
        // Åldersberäkning: försök först hämta eventdate från DB (valfri rad), annars från XML StartDate
        let eventdate = null;
        const eventdateRes = await supabase
          .from('events')
          .select('eventdate')
          .eq('eventid', eventId)
          .limit(1);
        if (eventdateRes?.data && eventdateRes.data.length > 0) {
          eventdate = eventdateRes.data[0].eventdate || null;
        }
        if (!eventdate) {
          const mStartDate = xml.match(/<StartDate>\s*<Date>(\d{4}-\d{2}-\d{2})<\/Date>/i);
          if (mStartDate) eventdate = mStartDate[1];
        }

        // parseResultsMultiDay returns { results, warnings }
        const { results: mdResults, warnings: mdWarnings } = parseResultsMultiDay(
          xml,
          eventId,
          organisationId,
          batchid,
          eventdate
        );
        parsed = mdResults;
        warningsFromParse = mdWarnings || [];
        // Extra guard: ta bort classresultnumberofstarts helt för multiday
        parsed = parsed.map(({ classresultnumberofstarts, ...rest }) => rest);
      } else if (eventform === 'RelaySingleDay') {
        // RelaySingleDay parser returns an object { results, warnings }
        const { results: relayResults, warnings: relayWarnings } = parseResultsRelay(xml);
        parsed = relayResults;
        warningsFromParse = relayWarnings || [];
      } else {
        // Standard single-day events: parse and destructure results and warnings.
        const { results: stdResults, warnings: stdWarnings } = parseResultsStandard(xml);
        parsed = stdResults;
        warningsFromParse = stdWarnings || [];
      }
    } catch (parseError) {
      console.error(`${logContext} Fel vid parsning av resultat:`, parseError);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        errormessage: `Fel vid parsning av resultat: ${parseError.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      return;
    }

    if (!parsed || parsed.length === 0) {
      console.log(`${logContext} 0 resultat hittades i Eventor`);
      return;
    } else {
      console.log(`${logContext} ${parsed.length} resultat tolkades från XML`);
    }

    // Sätt batchid och klubb på varje rad (om inte redan satt)
    for (const row of parsed) {
      row.batchid = batchid;
      row.clubparticipation = organisationId;
      row.eventid = eventId;
    }

    // Logga och skriv varningar till warnings-tabellen.  Alla parser
    // returnerar warnings som en array av strängar.  Vi loggar dem
    // först på konsolen och därefter försöker vi skriva en rad per
    // varning i tabellen "warnings".  Varje rad innehåller
    // organisationid, eventid, batchid, personid=0, ett meddelande
    // samt ett tidsstämplat created-fält.  Om insert misslyckas
    // loggas felet med insertLogData.
    try {
      if (warningsFromParse && warningsFromParse.length > 0) {
        for (const warn of warningsFromParse) {
          console.warn(`[parseResults][Warning] ${warn}`);
        }
        const warningRows = warningsFromParse.map((msg) => ({
          organisationid: organisationId,
          eventid: eventId,
          batchid: batchid,
          personid: 0,
          message: msg,
          created: new Date().toISOString()
        }));
        const { error: warningsInsertError } = await supabase
          .from('warnings')
          .insert(warningRows);
        if (warningsInsertError) {
          console.error(`${logContext} Fel vid insert av warnings:`, warningsInsertError.message);
          await insertLogData(supabase, {
            source: 'GetResultsFetcher',
            level: 'error',
            errormessage: `Fel vid insert av warnings: ${warningsInsertError.message}`,
            organisationid: organisationId,
            eventid: eventId,
            batchid
          });
        }
      }
    } catch (warningInsertException) {
      console.error(`${logContext} Undantag vid insert av warnings:`, warningInsertException);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        errormessage: `Undantag vid insert av warnings: ${warningInsertException.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
    }

    const { status, error: insertError } = await supabase
      .from('results')
      .insert(parsed);

    if (insertError) {
      console.error(`${logContext} Fel vid insert:`, insertError.message);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        errormessage: `Fel vid insert: ${insertError.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      return;
    }

    console.log(`${logContext} Insertstatus: ${status}`);
  } catch (e) {
    console.error(`${logContext} Ovänterat fel:`, e);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `Ovänterat fel: ${e.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
  }
}

async function fetchResultsForClub({ organisationId, batchid, apikey }) {
  console.log(`[GetResults] === START club ${organisationId} ===`);

  // Hämta eventId:n från events (senaste batchen eller allt du vill köra)
  const { data: events, error: eventsErr } = await supabase
    .from('events')
    .select('eventid')
    .eq('eventorganiser', organisationId);

  if (eventsErr) {
    console.error('[GetResults] Fel vid hämtning av events:', eventsErr.message);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `Fel vid hämtning av events: ${eventsErr.message}`,
      organisationid: organisationId,
      batchid
    });
    return;
  }

  if (!events || events.length === 0) {
    console.log('[GetResults] 0 eventid hittades i tabellen events');
    return;
  }

  console.log(`[GetResults] ${events.length} eventid hittades i tabellen events`);
  for (const event of events) {
    await fetchResultsForEvent({
      organisationId,
      eventId: event.eventid,
      batchid,
      apikey
    });
  }

  console.log(`[GetResults] === SLUT club ${organisationId} ===`);
}

module.exports = { fetchResultsForEvent, fetchResultsForClub };
