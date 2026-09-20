import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,describe,expect,it,vi} from 'vitest';
import IntelligenceVisibility from './IntelligenceVisibility';
import IntelligenceClassification from './IntelligenceClassification';
afterEach(()=>vi.unstubAllGlobals());
describe('native-score visibility explanations',()=>{
 it('discloses exact unchanged defaults and separates exploration from accuracy claims',()=>{
  vi.stubGlobal('React',React);const text=renderToStaticMarkup(React.createElement(IntelligenceVisibility)).replace(/<[^>]*>/g,'');
  expect(text).toContain('80% topic probability');expect(text).toContain('75% concrete development');expect(text).toContain('No measured calibration');expect(text).toContain('does not estimate accuracy or change publication');
 });
 it('renders original native probabilities even if an older contract lacks content classifications',()=>{
  vi.stubGlobal('React',React);const text=renderToStaticMarkup(React.createElement(IntelligenceClassification,{attributes:{companyRelevance:.73,concreteEvent:.61}})).replace(/<[^>]*>/g,'');
  expect(text).toContain('Company relevance 73%');expect(text).toContain('Concrete development 61%');
 });
});
