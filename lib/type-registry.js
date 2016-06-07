'use strict'
/**
 * Provides Solid helper functions involved with loading the Type Index
 * Registry files, and with registering resources with them.
 * @module type-registry
 */
module.exports.initTypeRegistry = initTypeRegistry
module.exports.loadTypeRegistry = loadTypeRegistry
module.exports.isUnlistedTypeIndex = isUnlistedTypeIndex
module.exports.isListedTypeIndex = isListedTypeIndex
module.exports.registerType = registerType
module.exports.unregisterType = unregisterType
module.exports.typeRegistryForClass = typeRegistryForClass

// var graphUtil = require('./util/graph-util')
var IndexRegistration = require('./solid/index-registration')
var rdf = require('./util/rdf-parser').rdflib
var webClient = require('./web')
// var SolidProfile = require('./solid/profile')
var util = require('./util/web-util.js')
var graphUtil = require('./util/graph-util.js')
var vocab = require('./vocab')

/**
 * Initializes a user's WebID profile with the type index registry.
 * @param profile {SolidProfile} User's WebID profile
 * @param container {Strong} The URL of the container for index documents
 * @param [options] Options hashmap (see solid.web.solidRequest() function docs)
 *   where the type indexes will be created
 * @return {<SolidProfile>}
 */
function initTypeRegistry (profile, containerUrl, options) {
  // Use same path as the WebID profile document if containerUrl is not provided
  containerUrl = containerUrl || profile.webId.replace(/\\/g, '/')
                                              .replace(/\/[^\/]*\/?$/, '') + '/'
  if (!containerUrl) {
    throw new Error('No location specified for type index creation')
  }
  var publicIndex = {
    slug: 'publicTypeIndex.ttl',
    data: `<> a <http://www.w3.org/ns/solid/terms#TypeIndex>,
            <http://www.w3.org/ns/solid/terms#ListedDocument> .`
  }
  var privateIndex = {
    slug: 'privateTypeIndex.ttl',
    data: `<> a <http://www.w3.org/ns/solid/terms#TypeIndex>,
            <http://www.w3.org/ns/solid/terms#UnlistedDocument> .`
  }

  return webClient.post(containerUrl, publicIndex.data, publicIndex.slug, options)
    .then(function (metaPublic) {
      var uri = util.absoluteUrl(containerUrl, metaPublic.url)
      var webid = rdf.sym(profile.webId)
      // patch profile
      var pubGraph = rdf.graph()
      pubGraph.add(webid, vocab.solid('publicTypeIndex'), rdf.sym(uri))
      var toAdd = []
      pubGraph.statementsMatching(webid, undefined, undefined)
        .forEach(function (st) {
          toAdd.push(st.toNT())
        })

      return webClient.patch(profile.webId, [], toAdd, options)
        .then(function (result) {
          profile.typeIndexListed.uri = uri
          if (!profile.preferences && profile.preferences.uri) {
            profile.typeIndexListed.graph = pubGraph
            profile.typeIndexListed.uri = uri
            return profile
          }
          // create privateIndex
          return webClient.post(containerUrl, privateIndex.data,
                                privateIndex.slug, options)
            .then(function (metaPrivate) {
              var uri = util.absoluteUrl(containerUrl, metaPrivate.url)
              profile.typeIndexUnlisted.uri = uri
              // patch profile
              var prvGraph = rdf.graph()
              prvGraph.add(webid, vocab.solid('privateTypeIndex'), rdf.sym(uri))
              var toAdd = []
              prvGraph.statementsMatching(webid, undefined, undefined)
                .forEach(function (st) {
                  toAdd.push(st.toNT())
                })

              return webClient.patch(profile.preferences.uri, [], toAdd, options)
                .then(function (result) {
                  profile.typeIndexUnlisted.graph = prvGraph
                  return profile
                })
                .catch(function (err) {
                  throw new Error('Could not update profile:' + err)
                })
            }).catch(function (err) {
              throw new Error('Could not create privateIndex document:' + err)
            })
        }).catch(function (err) {
          throw new Error('Could not update profile:' + err)
        })
    })
    .catch(function (err) {
      throw new Error('Could not create publicIndex document:' + err)
    })
}

/**
 * Adds an RDF class to a user's type index registry.
 * Called by `registerTypeIndex()`, which does all the argument validation.
 * @param profile {SolidProfile} User's WebID profile
 * @param rdfClass {rdf.NamedNode} Type to register in the index.
 * @param location {String} Absolute URI  to the location you want the class
 *   registered to.
 * @param locationType {String} Either 'instance' or 'container'
 * @param isListed {Boolean} Whether to register in a listed or unlisted index).
 * @return {<SolidProfile>}
 */
function addToTypeIndex (profile, rdfClass, location, locationType,
                         isListed) {
  // TODO: Check to see if a registry entry for this type already exists.
  // Generate a fragment identifier for the new registration
  var hash = require('shorthash')
  var fragmentId = hash.unique(rdfClass.uri)
  var registryUri
  var registryGraph
  if (isListed) {
    registryUri = profile.typeIndexListed.uri
    registryGraph = profile.typeIndexListed.graph
  } else {
    registryUri = profile.typeIndexUnlisted.uri
    registryGraph = profile.typeIndexUnlisted.graph
  }
  if (!registryUri) {
    throw new Error('Cannot register type, registry URL missing')
  }
  var registrationUri = rdf.sym(registryUri + '#' + fragmentId)
  // Set the class for the location type
  var locationTypeClass
  if (locationType === 'instance') {
    locationTypeClass = vocab.solid('instance')
  } else {
    locationTypeClass = vocab.solid('instanceContainer')
    // Add trailing slash if it's missing and is a container
    if (location.lastIndexOf('/') !== location.length - 1) {
      location += '/'
    }
  }
  // triples to delete
  var toDel = null
  // Create the list of triples to add in the PATCH operation
  var graph = rdf.graph()
  // e.g. <#ab09fd> a solid:TypeRegistration;
  graph.add(registrationUri, vocab.rdf('type'), vocab.solid('TypeRegistration'))
  // e.g. solid:forClass sioc:Post;
  graph.add(registrationUri, vocab.solid('forClass'), rdfClass)
  // e.g. solid:instanceContainer </posts/>.
  graph.add(registrationUri, locationTypeClass, rdf.sym(location))

  var toAdd = []
  graph.statementsMatching(registrationUri, undefined, undefined)
    .forEach(function (st) {
      toAdd.push(st.toNT())
    })

  return webClient.patch(registryUri, toDel, toAdd)
    .then(function () {
      // Update the profile object with the new registry without reloading
      if (!registryGraph) {
        registryGraph = graph
      }
      graphUtil.appendGraph(registryGraph, graph, registryUri)
      return profile
    })
}

/**
 * Returns true if the parsed graph is a `solid:UnlistedDocument` document.
 * @method isUnlistedTypeIndex
 * @param graph {$rdf.IndexedFormula} Parsed graph (loaded from a type index
 *   resource)
 * @return {Boolean}
 */
function isUnlistedTypeIndex (graph) {
  return graph.any(null, null, vocab.solid('UnlistedDocument'), graph.uri)
}

/**
 * Returns true if the parsed graph is a `solid:ListedDocument` document.
 * @method isListedTypeIndex
 * @param graph {$rdf.IndexedFormula} Parsed graph (loaded from a type index
 *   resource)
 * @return {Boolean}
 */
function isListedTypeIndex (graph) {
  return graph.any(null, null, vocab.solid('ListedDocument'), graph.uri)
}

/**
 * Loads the public and private type registry index resources, adds them
 * to the profile, and returns the profile.
 * Called by the profile.loadTypeRegistry() alias method.
 * Usage:
 *
 *   ```
 * var profile = solid.getProfile(url, options)
 *   .then(function (profile) {
 *     return profile.loadTypeRegistry(options)
 *   })
 *   ```
 * @method loadTypeRegistry
 * @param profile {SolidProfile}
 * @param [options] Options hashmap (see solid.web.solidRequest() function docs)
 * @return {Promise<SolidProfile>}
 */
function loadTypeRegistry (profile, options) {
  options = options || {}
  options.headers = options.headers || {}
  // Politely ask for Turtle format
  if (!options.headers['Accept']) {
    options.headers['Accept'] = 'text/turtle'
  }
  // load public and private index resources
  var links = []
  if (profile.typeIndexListed.uri) {
    links.push(profile.typeIndexListed.uri)
  }
  if (profile.typeIndexUnlisted.uri) {
    links.push(profile.typeIndexUnlisted.uri)
  }
  return webClient.loadParsedGraphs(links, options)
    .then(function (loadedGraphs) {
      loadedGraphs.forEach(function (graph) {
        // For each index resource loaded, add it to `profile.typeIndexListed`
        //  or `profile.typeIndexUnlisted` as appropriate
        if (graph && graph.value) {
          profile.addTypeRegistry(graph.value, graph.uri)
        }
      })
      return profile
    })
}

/**
 * Registers a given RDF class in the user's type index registries, so that
 * other applications can discover it.
 * @method registerType
 * @param profile {SolidProfile} Loaded WebID profile
 * @param rdfClass {rdf.NamedNode} Type to register in the index.
 * @param location {String} Absolute URI to the location you want the class
 *   registered to. (Example: Registering Address books in
 *   `https://example.com/contacts/`)
 * @param [locationType='container'] {String} Either 'instance' or 'container',
 *   defaults to 'container'
 * @param [isListed=false] {Boolean} Whether to register in a listed or unlisted
 *   index). Defaults to `false` (unlisted).
 * @return {Promise<SolidProfile>}
 */
function registerType (profile, rdfClass, location, locationType, isListed) {
  if (!profile) {
    throw new Error('No profile provided')
  }
  if (!profile.isLoaded) {
    throw new Error('Profile is not loaded')
  }
  if (!rdfClass || !location) {
    throw new Error('Type registration requires type class and location')
  }
  locationType = locationType || 'container'
  if (locationType !== 'container' && locationType !== 'instance') {
    throw new Error('Invalid location type')
  }
  return loadTypeRegistry(profile)  // make sure type registry is loaded
    .then(function (profile) {
      if (isListed && !profile.typeIndexListed.graph) {
        throw new Error('Profile has no Listed type index')
      }
      if (!isListed && !profile.typeIndexUnlisted.graph) {
        throw new Error('Profile has no Unlisted type index')
      }
      return addToTypeIndex(profile, rdfClass, location, locationType,
        isListed)
    })
}

/**
 * Returns lists of registry entries for a profile and a given RDF Class.
 * @method typeRegistryForClass
 * @param profile {SolidProfile}
 * @param rdfClass {rdf.NamedNode} RDF Class
 * @return {Array<IndexRegistration>}
 */
function typeRegistryForClass (profile, rdfClass) {
  var registrations = []
  var isListed = true

  return registrations
    .concat(
      registrationsFromGraph(profile.typeIndexListed.graph, rdfClass, isListed)
    )
    .concat(
      registrationsFromGraph(profile.typeIndexUnlisted.graph, rdfClass,
        !isListed)
    )
}

/**
 * Returns a list of registry entries from a given parsed type index graph.
 * @method registrationsFromGraph
 * @param graph {rdf.IndexedFormula} Parsed type index graph
 * @param rdfClass {rdf.NamedNode} RDF Class
 * @param isListed {Boolean} Whether to register in a listed or unlisted index
 * @return {Array<IndexRegistration>}
 */
function registrationsFromGraph (graph, rdfClass, isListed) {
  var entrySubject
  var locations = []
  var registrations = []
  if (!graph) {
    return registrations
  }

  var matches = graph.statementsMatching(null, null, rdfClass)
  matches.forEach(function (match) {
    entrySubject = match.subject
    // Have the hash fragment of the registration, now need to determine
    // location type, and the actual location.
    locations = graph.statementsMatching(entrySubject,
                                        vocab.solid('instance'), undefined)
    if (locations.length > 0) {
      locations.forEach(function (location) {
        registrations.push(new IndexRegistration(entrySubject.uri, rdfClass,
          'instance', location.object.uri, isListed))
      })
    }
    // Now try to find solid:instanceContainer matches
    locations = graph.statementsMatching(entrySubject,
                                    vocab.solid('instanceContainer'), undefined)
    if (locations.length > 0) {
      locations.forEach(function (location) {
        registrations.push(new IndexRegistration(entrySubject.uri, rdfClass,
          'container', location.object.uri, isListed))
      })
    }
  })
  return registrations
}

/**
 * Returns a list of statements related to a given registry entry, to remove
 * them via PATCH, see `removeFromTypeIndex()`.
 * @param registryGraph {$rdf.IndexedFormula} Type index registry graph
 * @param registration {IndexRegistration} Type index registry entry to generate
 *   statements from.
 * @return {Array<String>} List of statements (in "canonical" string format)
 *   related to the registry.
 */
function registryTriplesFor (registryGraph, registration) {
  var statements = []
  // Return all statements related to the registry entry (that have it as
  // the subject)
  registryGraph.statementsMatching(rdf.sym(registration.registrationUri))
    .forEach(function (match) {
      statements.push(match.toNT())
    })
  return statements
}

/**
 * Removes an RDF class from a user's type index registry.
 * Called by `unregisterTypeIndex()`, which does all the argument validation.
 * @param profile {SolidProfile} User's WebID profile
 * @param rdfClass {rdf.NamedNode} Type to remove from the registry
 * @param isListed {Boolean} Whether to remove from a listed or unlisted index
 * @param [location] {String} If present, only unregister the class from this
 *   location (absolute URI).
 * @return {Promise<SolidProfile>}
 */
function removeFromTypeIndex (profile, rdfClass, isListed, location) {
  var registryUri
  var registryGraph
  if (isListed) {
    registryUri = profile.typeIndexListed.uri
    registryGraph = profile.typeIndexListed.graph
  } else {
    registryUri = profile.typeIndexUnlisted.uri
    registryGraph = profile.typeIndexUnlisted.graph
  }
  if (!registryUri) {
    throw new Error('Cannot unregister type, registry URL missing')
  }
  // Get the existing registrations
  var registrations = registrationsFromGraph(registryGraph, rdfClass, isListed)
  if (registrations.length === 0) {
    // No existing registrations, no need to do anything, just return profile
    return new Promise(function (resolve, reject) {
      resolve(profile)
    })
  }
  if (location) {
    // If location is present, filter the to-remove list only to registrations
    // that are in that location.
    registrations = registrations.filter(function (registration) {
      return registration.locationUri === location
    })
  }
  // Generate triples to delete
  var toDel = []
  registrations.forEach(function (registration) {
    toDel = toDel.concat(registryTriplesFor(registryGraph, registration))
  })
  // Nothing to add
  var toAdd = []
  return webClient.patch(registryUri, toDel, toAdd)
    .then(function (result) {
      // Update the registry, to reflect new state
      return profile.loadTypeRegistry()
    })
}

/**
 * Removes a given RDF class from a user's type index registry, so that
 * other applications can discover it.
 * @method unregisterType
 * @param profile {SolidProfile} Loaded WebID profile
 * @param rdfClass {rdf.NamedNode} Type to register in the index.
 * @param [isListed=false] {Boolean} Whether to remove from a listed or unlisted
 *   index). Defaults to `false` (unlisted).
 * @param [location] {String} If present, only unregister the class from this
 *   location (absolute URI).
 * @return {Promise<SolidProfile>}
 */
function unregisterType (profile, rdfClass, isListed, location) {
  if (!profile) {
    throw new Error('No profile provided')
  }
  if (!profile.isLoaded) {
    throw new Error('Profile is not loaded')
  }
  if (!rdfClass) {
    throw new Error('Unregistering a type requires type class')
  }
  return loadTypeRegistry(profile)  // make sure type registry is loaded
    .then(function (profile) {
      if (isListed && !profile.typeIndexListed.graph) {
        throw new Error('Profile has no Listed type index')
      }
      if (!isListed && !profile.typeIndexUnlisted.graph) {
        throw new Error('Profile has no Unlisted type index')
      }
      return removeFromTypeIndex(profile, rdfClass, isListed, location)
    })
}
