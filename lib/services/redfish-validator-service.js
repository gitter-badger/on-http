// Copyright 2016, EMC, Inc.

'use strict';

var di = require('di');
var path = require('path');

module.exports = redfishValidatorFactory;

di.annotate(redfishValidatorFactory, new di.Provide('Http.Api.Services.Redfish'));
di.annotate(redfishValidatorFactory,
    new di.Inject(
        'Services.Configuration',
        'Logger',
        'Promise',
        '_',
        'fs',
        'Templates',
        'ejs'
    )
);

function redfishValidatorFactory(
    configuration,
    Logger,
    Promise,
    _,
    nodeFs,
    templates,
    ejs
) {
    var logger = Logger.initialize(redfishValidatorFactory);
    var fs = Promise.promisifyAll(nodeFs);
    var tv4 = require('tv4');
    var ready;
    var schemaNsMap = {};
    var schemaTitle = {};

    function RedfishValidator() {
        var redfishV1 = [{
                root: path.resolve(__dirname, '../../static/DSP8010_1.0.0/json-schema'),
                namespace: 'http://redfish.dmtf.org/schemas/v1/'
            },
            {
                root: path.resolve(__dirname, '../../static/DSP8010_1.0.0/json-schema-oem'),
                namespace: 'http://redfish.dmtf.org/schemas/v1/'
            }
        ];

        var schemaConfig = configuration.get('schemaConfig', redfishV1 );

        // add the redfishV1 schema if someone defined schemaConfig but left it out
        if( !_.some(schemaConfig, function(config) {
                return config.namespace.indexOf('http://redfish.dmtf.org/schemas/v1/') === 0;
            })) 
        {
            logger.warning('Adding Redfish V1 schema missing from schemaConfig');
            schemaConfig.push.apply(schemaConfig, redfishV1);
        }

        ready = Promise.map(schemaConfig, function(config) {
            return fs.readdirAsync(config.root).filter(function(entry) {
                return (path.extname(entry) === '.json');
            }).map(function(entry) {
                return fs.readFileAsync(config.root + '/' + entry)
                    .then(function(contents) {
                        try {
                            var json = JSON.parse(contents);
                            tv4.addSchema(config.namespace + entry, json);
                            schemaNsMap[entry] = config.namespace;
                            if( _.has(json, 'title')) {
                                schemaTitle[json.title] = config.namespace + entry;
                            } else {
                                logger.warning('no title found in ' + entry);
                            }
                        } catch(err) {
                            logger.warning('error loading schema:' + entry);
                        }
                    });
            });
        });
    }

    RedfishValidator.prototype.validate = function(obj, schemaName)  {
        return Promise.all(ready).then(function() {
            var basename = schemaName.split('#')[0];
            if (!_.has(schemaNsMap, basename))  {
                return Promise.reject(schemaName + ' is not loaded');
            }
            return tv4.validateResult(obj, tv4.getSchema(schemaNsMap[basename] + schemaName));
        });
    };

    RedfishValidator.prototype.missing = function() {
        return tv4.missing;
    };

    RedfishValidator.prototype.get = function(templateName, options) {
        return templates.get(templateName, options.templateScope || ['global'])
            .then(function(template) {
                return template.contents;
            })
            .then(function(contents) {
                return JSON.parse(ejs.render(contents, options));
            });
    };

    RedfishValidator.prototype.render = function(templateName, schemaName, options) {
        var self = this;
        return self.get(templateName, options)
            .then(function(output) {
                return self.validate(output, schemaName)
                    .then(function(result) {
                        if(result.error) {
                            throw new Error(result.error);
                        } 
                        return output;
                    });
            });
    };

    RedfishValidator.prototype.makeOptions = function(req, res, identifier) {
        return {
            basepath: req.swagger.operation.api.basePath,
            templateScope: ['global'],
            url: req.url,
            identifier: identifier
        };
    };

    return new RedfishValidator();
}
